import ROSModule, * as ROS from '@alicloud/ros20190910';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const Client = ROSModule.default || ROSModule;
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const ready = status => ['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(status);
const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const ref = name => ({ Ref: name });

export function backendNames(config) {
  const hash = createHash('sha256').update(`${config.accountId}:${config.region}:${config.project}:${config.backend.functionName}`).digest('hex').slice(0, 16);
  return { stackName: `pi-aliyun-fc-${hash}`, codeBucket: `pi-aliyun-code-${hash}-${config.accountId}` };
}

export function createRosClient(credential) {
  return new Client({ credential, endpoint: 'ros.aliyuncs.com', protocol: 'https', connectTimeout: 10000, readTimeout: 30000 });
}

export function backendTemplate(config, codeObject, environment, tls) {
  const b = config.backend;
  const parameters = { Certificate: { Type: 'String', NoEcho: true }, PrivateKey: { Type: 'String', NoEcho: true } };
  const values = { Certificate: tls.certificate, PrivateKey: tls.privateKey };
  const variables = {};
  // Keep application secrets and PEM material out of GetTemplate and diagnostic output.
  for (const [index, [key, value]] of Object.entries({ ...environment, PORT: String(b.port) }).sort(([a], [b]) => a.localeCompare(b)).entries()) {
    const name = `Environment${index}`;
    parameters[name] = { Type: 'String', NoEcho: true };
    values[name] = value;
    variables[key] = ref(name);
  }
  const template = {
    ROSTemplateFormatVersion: '2015-09-01',
    Description: `Managed by pi-aliyun: ${config.project}`,
    Parameters: parameters,
    Metadata: { CertificateFingerprint: new X509Certificate(tls.certificate).fingerprint256 },
    Resources: {
      Function: { Type: 'ALIYUN::FC3::Function', Properties: {
        FunctionName: b.functionName, Description: `Managed by pi-aliyun: ${config.project}`,
        Runtime: b.runtime, Handler: 'index.handler', Code: { OssBucketName: backendNames(config).codeBucket, OssObjectName: codeObject },
        Cpu: b.cpu, MemorySize: b.memorySize, DiskSize: 512, Timeout: b.timeout, InstanceConcurrency: b.instanceConcurrency,
        InternetAccess: true, EnvironmentVariables: variables,
        CustomRuntimeConfig: { Command: b.command.slice(0, 1), Args: b.command.slice(1), Port: b.port },
        ...(b.role ? { Role: b.role } : {}),
        ...(b.vpcConfig ? { VpcConfig: { VpcId: b.vpcConfig.vpcId, VSwitchIds: b.vpcConfig.vSwitchIds, SecurityGroupId: b.vpcConfig.securityGroupId } } : {}),
      } },
      Concurrency: { Type: 'ALIYUN::FC3::ConcurrencyConfig', Properties: { FunctionName: { 'Fn::GetAtt': ['Function', 'FunctionName'] }, ReservedConcurrency: b.maxInstances } },
      HttpTrigger: { Type: 'ALIYUN::FC3::Trigger', DependsOn: 'Concurrency', Properties: {
        FunctionName: { 'Fn::GetAtt': ['Function', 'FunctionName'] }, TriggerName: 'http', TriggerType: 'http', Qualifier: 'LATEST',
        TriggerConfig: { authType: 'anonymous', methods, disableURLInternet: true },
      } },
      Domain: { Type: 'ALIYUN::FC3::CustomDomain', DependsOn: 'HttpTrigger', Properties: {
        DomainName: b.domain, Protocol: 'HTTPS', AuthConfig: { AuthType: 'anonymous' },
        CertConfig: { CertName: `${config.project}-tls`, Certificate: ref('Certificate'), PrivateKey: ref('PrivateKey') },
        RouteConfig: { Routes: [{ FunctionName: { 'Fn::GetAtt': ['Function', 'FunctionName'] }, Path: '/*', Qualifier: 'LATEST', Methods: methods }] },
      } },
    },
  };
  return { template, parameters: Object.entries(values).map(([parameterKey, parameterValue]) => ({ parameterKey, parameterValue })) };
}

async function getStack(ros, config, stackId) {
  return (await ros.getStack(new ROS.GetStackRequest({ regionId: config.region, stackId, logOption: 'None', outputOption: 'Disabled' }))).body;
}

export async function findBackendStack(ros, config) {
  const { stackName } = backendNames(config);
  const { body } = await ros.listStacks(new ROS.ListStacksRequest({ regionId: config.region, stackName: [stackName], pageSize: 50 }));
  const matches = (body.stacks || []).filter(stack => stack.stackName === stackName && stack.status !== 'DELETE_COMPLETE');
  ensure(matches.length <= 1 && !(body.totalCount > 50), 'Ambiguous ROS backend stack; inspect the existing resources');
  if (!matches.length) return;
  const stack = await getStack(ros, config, matches[0].stackId);
  ensure(stack.tags?.some(tag => tag.key === 'pi-aliyun-project' && tag.value === config.project), 'ROS stack is not managed by this project');
  return stack;
}

export async function readBackendTemplate(ros, config, stack) {
  const { body } = await ros.getTemplate(new ROS.GetTemplateRequest({ regionId: config.region, stackId: stack.stackId, templateStage: 'Original' }));
  const template = typeof body.templateBody === 'string' ? JSON.parse(body.templateBody) : body.templateBody;
  const resources = template?.Resources;
  const types = { Function: 'ALIYUN::FC3::Function', Concurrency: 'ALIYUN::FC3::ConcurrencyConfig', HttpTrigger: 'ALIYUN::FC3::Trigger', Domain: 'ALIYUN::FC3::CustomDomain' };
  ensure(template?.Description === `Managed by pi-aliyun: ${config.project}` && resources
    && Object.keys(resources).length === 4 && Object.entries(types).every(([name, type]) => resources[name]?.Type === type)
    && resources.Function.Properties.FunctionName === config.backend.functionName
    && resources.Function.Properties.Code?.OssBucketName === backendNames(config).codeBucket
    && resources.Domain.Properties.DomainName === config.backend.domain,
  'ROS template has different ownership or additional resources; inspect it before changing this application');
  return template;
}

export async function waitForStack(ros, config, stackId, desired, { attempts = 121, wait = () => delay(5000), previousStack } = {}) {
  let previous;
  let changed = !previousStack;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const stack = await getStack(ros, config, stackId);
    changed ||= stack.status !== previousStack.status || stack.updateTime !== previousStack.updateTime;
    if (stack.status !== previous) console.log(`ROS ${stackId}: ${stack.status}`);
    previous = stack.status;
    if (changed && stack.status === desired) return stack;
    if (changed && !stack.status?.endsWith('_IN_PROGRESS')) {
      const { body } = await ros.listStackEvents(new ROS.ListStackEventsRequest({ regionId: config.region, stackId, pageSize: 20 }));
      // Upstream status reasons can contain resource properties; only expose known error categories.
      const reasons = (body.events || []).map(event => event.statusReason || '').join('\n');
      const code = ['DomainNameNotResolved', 'AccessDenied', 'Forbidden', 'InvalidArgument', 'AlreadyExists', 'InvalidParameter'].find(code => reasons.includes(code));
      throw Object.assign(new Error(`ROS stack ${stackId} ended in ${stack.status}${code ? ` (${code})` : ''}. Inspect ROS stack events and retry the same application configuration.`), { code: code || 'RosStackFailed' });
    }
    if (attempt < attempts - 1) await wait();
  }
  throw new Error(`ROS stack ${stackId} is still running. Inspect status before retrying; do not create a second application.`);
}

export async function inspectCodeBucket(oss, config) {
  const { codeBucket } = backendNames(config);
  try {
    const info = await oss.getBucketInfo(codeBucket);
    const { tag } = await oss.getBucketTags(codeBucket);
    ensure(String(info.bucket.Owner.ID) === config.accountId && [config.region, `oss-${config.region}`].includes(info.bucket.Location)
      && tag['pi-aliyun-project'] === config.project && tag['pi-aliyun-purpose'] === 'backend-code', 'Code bucket is not managed by this application');
    const { acl } = await oss.getBucketACL(codeBucket);
    ensure(acl === 'private', 'Backend code bucket must remain private');
    return { exists: true, ok: true, name: codeBucket };
  } catch (error) {
    if (error.code === 'NoSuchBucket') return { exists: false, ok: false, name: codeBucket };
    throw error;
  }
}

async function uploadCode(oss, config, archive) {
  const { codeBucket } = backendNames(config);
  if (!(await inspectCodeBucket(oss, config)).exists) {
    await oss.putBucket(codeBucket, { acl: 'private', storageClass: 'Standard' });
    await oss.putBucketTags(codeBucket, { 'pi-aliyun-project': config.project, 'pi-aliyun-purpose': 'backend-code' });
  }
  const key = `code/${createHash('sha256').update(archive).digest('hex')}.zip`;
  await oss.put(key, archive, { headers: { 'Content-Type': 'application/zip' } });
  return key;
}

async function updateStack(ros, config, stack, template, parameters, options) {
  try {
    await ros.updateStack(new ROS.UpdateStackRequest({ regionId: config.region, stackId: stack.stackId,
      templateBody: JSON.stringify(template), parameters, usePreviousParameters: true, timeoutInMinutes: 10,
      replacementOption: 'Enabled', clientToken: randomUUID() }));
  } catch (error) {
    // ROS rejects an identical update rather than returning success.
    if (error.code === 'NotSupported' && /^Update the completely same stack [A-Za-z0-9_-]+ is not supported\.$/.test(error.data?.Message || error.data?.message || '') && ready(stack.status)) return;
    throw error;
  }
  await waitForStack(ros, config, stack.stackId, 'UPDATE_COMPLETE', { ...options, previousStack: stack });
}

export async function deployBackend(clients, config, archive, environment, tls, options = {}) {
  const { ros, codeOss } = clients;
  let stack = await findBackendStack(ros, config);
  if (stack) {
    await readBackendTemplate(ros, config, stack);
    if (['ROLLBACK_COMPLETE', 'CREATE_ROLLBACK_COMPLETE'].includes(stack.status)) {
      await deleteBackendStack(ros, config, options);
      stack = undefined;
    } else ensure(ready(stack.status) || stack.status === 'UPDATE_ROLLBACK_COMPLETE', `ROS stack ${stack.stackId} is ${stack.status}; inspect it before retrying`);
  }
  const codeObject = await uploadCode(codeOss, config, archive);
  const { template, parameters } = backendTemplate(config, codeObject, environment, tls);
  if (stack) await updateStack(ros, config, stack, template, parameters, options);
  else {
    const { body } = await ros.createStack(new ROS.CreateStackRequest({ regionId: config.region, stackName: backendNames(config).stackName,
      templateBody: JSON.stringify(template), parameters, timeoutInMinutes: 10, disableRollback: false,
      clientToken: randomUUID(), tags: [{ key: 'pi-aliyun-project', value: config.project }] }));
    ensure(body.stackId, 'ROS did not return a stack ID; inspect stacks before retrying');
    await waitForStack(ros, config, body.stackId, 'CREATE_COMPLETE', options);
  }
}

export async function renewBackendCertificate(ros, config, tls, options = {}) {
  const stack = await findBackendStack(ros, config);
  ensure(stack && ready(stack.status), 'Backend ROS stack must be successfully deployed before renewing HTTPS');
  const template = await readBackendTemplate(ros, config, stack);
  const fingerprint = new X509Certificate(tls.certificate).fingerprint256;
  if (template.Metadata?.CertificateFingerprint === fingerprint) return;
  template.Metadata = { ...template.Metadata, CertificateFingerprint: fingerprint };
  await updateStack(ros, config, stack, template, [
    { parameterKey: 'Certificate', parameterValue: tls.certificate }, { parameterKey: 'PrivateKey', parameterValue: tls.privateKey },
  ], options);
}

export async function inspectBackend(ros, config) {
  const stack = await findBackendStack(ros, config);
  if (!stack) return { exists: false, ok: false, name: backendNames(config).stackName };
  const template = await readBackendTemplate(ros, config, stack);
  return { exists: true, ok: ready(stack.status), stackId: stack.stackId, state: stack.status, name: stack.stackName,
    functionName: config.backend.functionName, domain: config.backend.domain, protocol: template.Resources.Domain.Properties.Protocol,
    source: 'ROS deployment state; use verify for live HTTPS acceptance' };
}

export async function deleteBackendStack(ros, config, options = {}) {
  const stack = await findBackendStack(ros, config);
  if (!stack) return;
  await readBackendTemplate(ros, config, stack);
  ensure(!stack.status.endsWith('_IN_PROGRESS') || stack.status === 'DELETE_IN_PROGRESS', 'ROS stack operation is still running');
  if (stack.status !== 'DELETE_IN_PROGRESS') await ros.deleteStack(new ROS.DeleteStackRequest({ regionId: config.region, stackId: stack.stackId, retainAllResources: false }));
  await waitForStack(ros, config, stack.stackId, 'DELETE_COMPLETE', { ...options, previousStack: stack });
}

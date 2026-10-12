// Copy into the application's backend and install tablestore there. No dependency on the deployment package at runtime.
import TableStore from 'tablestore';
import Proto from 'tablestore/lib/protocol/tablestore_compiled_proto.js';

export function createTablestoreClient(options) {
  const client = new TableStore.Client(options);
  const extractXmlError = client.extractError;
  // SDK 5.6.5 only parses XML errors, but the data endpoint also returns protobuf errors.
  client.extractError = function (response) {
    let decoded;
    try { decoded = Proto.main.proto.Error.decode(response.httpResponse.body); } catch { /* XML uses the SDK parser below. */ }
    if (typeof decoded?.code === 'string' && /^OTS[A-Za-z0-9_]+$/.test(decoded.code)) {
      response.error = Object.assign(new Error(decoded.message || decoded.code), { code: decoded.code,
        statusCode: response.httpResponse.statusCode,
        requestId: response.httpResponse.headers['x-ots-requestid'] || response.httpResponse.headers['x-ots-request-id'] });
    } else {
      extractXmlError.call(this, response);
      if (response.error) response.error.statusCode = response.httpResponse.statusCode;
    }
  };
  return client;
}

export function databaseForRequest(request, env = process.env) {
  // Debian 10 forwards fresh role credentials per request. Later runtimes provide FC-managed environment credentials.
  // Call after application authentication; never expose, log, or persist these values.
  const h = request.headers || {};
  const headerKeys = [h['x-fc-access-key-id'], h['x-fc-access-key-secret'], h['x-fc-security-token']];
  const keys = headerKeys.every((value) => typeof value === 'string' && value)
    ? headerKeys : [env.ALIBABA_CLOUD_ACCESS_KEY_ID, env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, env.ALIBABA_CLOUD_SECURITY_TOKEN];
  if (keys.some((value) => typeof value !== 'string' || !value)) throw new Error('FC runtime role credentials are unavailable');
  const endpoint = new URL(env.TABLESTORE_ENDPOINT);
  if (endpoint.protocol !== 'https:' || !/^[a-z][a-z0-9-]+\.[a-z0-9-]+\.ots\.aliyuncs\.com$/.test(endpoint.hostname) || !endpoint.hostname.startsWith(`${env.TABLESTORE_INSTANCE}.`) || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Invalid Tablestore endpoint');
  const tables = JSON.parse(env.TABLESTORE_TABLES || '{}');
  const client = createTablestoreClient({ accessKeyId: keys[0], secretAccessKey: keys[1], stsToken: keys[2],
    endpoint: endpoint.origin, instancename: env.TABLESTORE_INSTANCE, maxRetries: 2, httpOptions: { timeout: 10000 } });
  return { client, tables, TableStore,
    call: (action, params) => new Promise((resolve, reject) => client[action](params, (error, data) => error ? reject(error) : resolve(data))) };
}

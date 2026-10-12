import { readdir, lstat, access } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import yazl from 'yazl';

const excluded = (name) => ['.git', '.aliyun', '.bin', '.DS_Store'].includes(name) || /^\.env(?:\.|$)/.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);

export async function collectFiles(directory) {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error('Deployment output must be a directory');
  const files = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded(entry.name)) continue;
      const current = join(path, entry.name);
      const key = relative(root, current).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Deployment output contains a symlink: ${key}; prepare a self-contained output directory`);
      if (entry.isDirectory()) await visit(current);
      else if (entry.isFile()) files.push({ path: current, key });
      else throw new Error(`Deployment output contains a non-regular file: ${key}`);
    }
  }
  await visit(root);
  if (!files.length) throw new Error('Deployment output is empty');
  return files;
}

export async function createArchive(files) {
  const zip = new yazl.ZipFile();
  const chunks = [];
  const output = new Promise((resolveOutput, reject) => {
    let size = 0;
    zip.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.on('data', (chunk) => {
      size += chunk.length;
      if (size > 60 * 1024 * 1024) {
        zip.outputStream.destroy(new Error('Backend ZIP exceeds 60 MiB; reduce dependencies or use a container deployment outside this tool'));
      } else chunks.push(chunk);
    });
    zip.outputStream.on('end', () => resolveOutput(Buffer.concat(chunks)));
  });
  for (const file of files) {
    const info = await lstat(file.path);
    zip.addFile(file.path, file.key, { mtime: new Date('2000-01-01T00:00:00Z'), mode: info.mode });
  }
  zip.end();
  return output;
}

async function runBuild(build, label) {
  if (!build) return;
  console.log(`Building ${label}`);
  // Build subprocesses do not need the deployment principal's environment credentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ALIBABA_CLOUD|ALICLOUD|OSS)_/.test(name)));
  await new Promise((resolveBuild, reject) => {
    const child = spawn(build.command[0], build.command.slice(1), { cwd: build.cwd, env, stdio: 'inherit', shell: false });
    child.on('error', () => reject(new Error(`${label} build command could not start`)));
    child.on('exit', (code, signal) => code === 0 ? resolveBuild() : reject(new Error(`${label} build failed (${signal || code})`)));
  });
}

export async function buildArtifacts(config) {
  await runBuild(config.backend?.build, 'backend');
  await runBuild(config.frontend?.build, 'frontend');
  const result = {};
  if (config.frontend) {
    result.frontendFiles = await collectFiles(config.frontend.dir);
    if (!result.frontendFiles.some((item) => item.key === 'index.html')) throw new Error('Frontend output requires index.html at its root');
  }
  const backendFiles = config.backend ? await collectFiles(config.backend.codeDir) : [];
  // Check the same file inventory that will be uploaded, before constructing a ZIP.
  const sensitivePaths = new Set([config.tls.certFile, config.tls.keyFile, config.tls.acme?.accountKeyFile].filter(Boolean));
  for (const file of [...(result.frontendFiles || []), ...backendFiles]) {
    if (sensitivePaths.has(file.path)) throw new Error('TLS material must be outside deployment output directories');
  }
  if (config.backend) {
    result.environment = { ...config.backend.environment };
    for (const [name, source] of Object.entries(config.backend.envFrom)) {
      if (!Object.hasOwn(process.env, source) || !process.env[source]) throw new Error(`Missing environment variable: ${source}`);
      result.environment[name] = process.env[source];
    }
    if (config.backend.command[0].startsWith('/code/')) {
      const entrypoint = config.backend.command[0].slice('/code/'.length);
      if (!backendFiles.some((file) => file.key === entrypoint)) throw new Error('Backend command executable under /code must exist in codeDir');
      await access(join(config.backend.codeDir, entrypoint), 1).catch(() => { throw new Error('Backend executable needs its executable permission bit'); });
    }
    result.backendArchive = await createArchive(backendFiles);
  }
  return result;
}

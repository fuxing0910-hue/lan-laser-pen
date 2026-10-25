const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const temporaryRoot = fs.realpathSync(os.tmpdir())
const directoryPrefix = 'lan-laser-pen-tests-'
let certificateDirectory

function findOpenSSL() {
  const candidates = ['openssl']
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    candidates.push(path.join(programFiles, 'Git', 'usr', 'bin', 'openssl.exe'))
    candidates.push(path.join(programFiles, 'Git', 'mingw64', 'bin', 'openssl.exe'))
  }
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true })
    if (!result.error && result.status === 0) return candidate
  }
  throw new Error('OpenSSL is required for temporary test TLS. Add it to PATH, or install Git for Windows with OpenSSL.')
}

function generateCertificate(openssl, args) {
  const result = spawnSync(openssl, args, { cwd: certificateDirectory, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`OpenSSL failed: ${result.stderr || result.stdout || result.signal || result.status}`)
}

function runNode(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status === null) throw new Error(`Node process ended without an exit code: ${result.signal || 'unknown error'}`)
  return result.status
}

function removeTestDirectory() {
  // Delete only the exact direct child created by this invocation, never a caller-supplied path.
  const resolved = path.resolve(certificateDirectory)
  const name = path.basename(resolved)
  if (path.dirname(resolved) !== temporaryRoot || !name.startsWith(directoryPrefix) || name.length <= directoryPrefix.length ||
      fs.lstatSync(resolved).isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error('Refusing to remove a temporary test directory outside the expected prefix.')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}

try {
  // Reuse an existing demo so tests do not rebuild pages being served during development.
  if (!fs.existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
    const buildStatus = runNode([path.join(__dirname, 'build.cjs'), 'demo'])
    if (buildStatus !== 0) throw new Error(`Demo build failed with exit code ${buildStatus}.`)
  }
  const openssl = findOpenSSL()
  certificateDirectory = fs.mkdtempSync(path.join(temporaryRoot, directoryPrefix))
  // Tests trust this one-day CA explicitly; the OS trust store and production certs are never used.
  generateCertificate(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', 'ca-key.pem', '-out', 'ca.pem', '-subj', '/CN=LAN Laser Pen Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  generateCertificate(openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'lan-key.pem',
    '-out', 'lan.csr', '-subj', '/CN=localhost'])
  fs.writeFileSync(path.join(certificateDirectory, 'leaf.ext'), [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '',
  ].join('\n'))
  generateCertificate(openssl, ['x509', '-req', '-in', 'lan.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem',
    '-CAcreateserial', '-out', 'lan.pem', '-days', '1', '-extfile', 'leaf.ext'])
  generateCertificate(openssl, ['x509', '-in', 'ca.pem', '-outform', 'DER', '-out', 'rootCA.cer'])
  const tests = fs.readdirSync(path.join(projectRoot, 'tests'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.cjs'))
    .map(entry => path.join('tests', entry.name)).sort()
  if (!tests.length) throw new Error('No tests/*.test.cjs files found.')
  process.exitCode = runNode(['--test', ...tests], { ...process.env, LASER_PEN_TEST_CERT_DIR: certificateDirectory })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  if (certificateDirectory) {
    try { removeTestDirectory() } catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}

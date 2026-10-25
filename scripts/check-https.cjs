const fs = require('node:fs')
const path = require('node:path')
const { X509Certificate, createPrivateKey } = require('node:crypto')
const { lanAddresses } = require('../server.cjs')

try {
  const addresses = lanAddresses()
  const cert = new X509Certificate(fs.readFileSync(path.join(__dirname, '../certs/lan.pem')))
  const root = new X509Certificate(fs.readFileSync(path.join(__dirname, '../certs/rootCA.cer')))
  const key = createPrivateKey(fs.readFileSync(path.join(__dirname, '../certs/lan-key.pem')))
  const missing = addresses.filter(address => !cert.checkIP(address))
  const ok = addresses.length > 0 && missing.length === 0 && Boolean(cert.checkHost('localhost')) &&
    Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now() + 86400000 &&
    cert.checkPrivateKey(key) && cert.verify(root.publicKey)
  process.stdout.write(JSON.stringify({ ok, addresses, missing }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }))
}

// frp v1 控制通道加密：AES-128-CFB，密钥 pbkdf2(token, "frp", 64, 16, sha1)，
// 每个方向在首次写入时先发送 16 字节随机 IV（golib/crypto；frp client/service.go 设 DefaultSalt = "frp"）。
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto'

const SALT = 'frp'
const IV_BYTES = 16

export function deriveKey(token) {
  return pbkdf2Sync(Buffer.from(String(token), 'utf8'), SALT, 64, 16, 'sha1')
}

/** frp token 认证的 privilege_key：md5(token + 十进制时间戳) 的十六进制。 */
export function privilegeKey(token, timestamp) {
  return createHash('md5').update(String(token)).update(String(timestamp)).digest('hex')
}

export class CfbWriter {
  constructor(key, iv = randomBytes(IV_BYTES)) {
    this.iv = iv
    this.cipher = createCipheriv('aes-128-cfb', key, iv)
    this.ivSent = false
  }

  encrypt(plain) {
    const out = this.cipher.update(plain)
    if (this.ivSent) return out
    this.ivSent = true
    return Buffer.concat([this.iv, out])
  }
}

export class CfbReader {
  constructor(key) {
    this.key = key
    this.pending = Buffer.alloc(0)
    this.decipher = null
  }

  decrypt(chunk) {
    if (!this.decipher) {
      this.pending = Buffer.concat([this.pending, chunk])
      if (this.pending.length < IV_BYTES) return Buffer.alloc(0)
      this.decipher = createDecipheriv('aes-128-cfb', this.key, this.pending.subarray(0, IV_BYTES))
      chunk = this.pending.subarray(IV_BYTES)
      this.pending = null
    }
    return this.decipher.update(chunk)
  }
}

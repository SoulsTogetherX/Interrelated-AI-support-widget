//#region Why scrypt, and why from the standard library
// Ported from OnlineWhiteboard's auth layer (backend/src/auth/password.ts) —
// the exact scheme the plan calls for. Passwords are hashed with scrypt via
// Node's built-in `crypto`. scrypt is a deliberately slow, MEMORY-hard key
// derivation function — memory-hardness is what blunts GPU/ASIC cracking
// rigs, which is the whole threat model for a leaked password table. It is
// an OWASP-accepted choice alongside argon2id.
//
// Standard library rather than a native argon2 addon is a deliberate trade:
// zero native-compilation risk on every platform this runs on (including
// Vercel's build image). The stored string is self-describing —
// `scrypt$N$saltHex$hashHex` — so raising the cost later doesn't invalidate
// old hashes, and migrating to argon2id one day is an "argon2$…" branch plus
// rehash-on-next-login, not a data migration.
//#endregion

//#region Imports
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"

import type { BinaryLike, ScryptOptions } from "node:crypto"
//#endregion

//#region Constants
// Hand-wrapped instead of util.promisify because promisify picks scrypt's
// 3-argument overload and drops the options parameter — and options (N,
// maxmem) is exactly where the cost tuning lives.
function scryptAsync(
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err)
      } else {
        resolve(derivedKey)
      }
    })
  })
}

// CPU/memory cost. 2^15 is a reasonable interactive-login setting; higher is
// safer but slower. Stored in the hash so it can change without breaking
// existing users.
const SCRYPT_COST = 32_768 // 2^15
const KEY_LENGTH = 64
const SALT_LENGTH = 16
//#endregion

//#region Public API
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    // scrypt's internal memory use is ~128 * N * r bytes; the default maxmem
    // (32MB) is too low for N=2^15, so raise the ceiling to match.
    maxmem: 128 * SCRYPT_COST * 8 * 2,
  })
  return `scrypt$${SCRYPT_COST}$${salt.toString("hex")}$${derived.toString("hex")}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 4 || parts[0] !== "scrypt") {
    return false
  }

  const cost = Number(parts[1])
  const salt = Buffer.from(parts[2], "hex")
  const expected = Buffer.from(parts[3], "hex")
  if (!Number.isInteger(cost) || salt.length === 0 || expected.length === 0) {
    return false
  }

  const derived = await scryptAsync(password, salt, expected.length, {
    N: cost,
    maxmem: 128 * cost * 8 * 2,
  })

  // timingSafeEqual requires equal-length buffers and compares in constant
  // time, so a wrong password can't be distinguished from a right one by how
  // long the comparison takes.
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}
//#endregion

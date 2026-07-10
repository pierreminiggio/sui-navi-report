/**
 * A Move `address` BCS-serializes as its raw 32 bytes (fixed-size type, no
 * length prefix) - confirmed during testing by hand-encoding this wallet's
 * own address and using it as a dynamic-field table key.
 */
export function addressToBcsBase64(address) {
  const hex = address.startsWith('0x') ? address.slice(2) : address

  if (hex.length !== 64) {
    throw new Error(`Expected a 32-byte (64 hex char) address, got: ${address}`)
  }

  return Buffer.from(hex, 'hex').toString('base64')
}

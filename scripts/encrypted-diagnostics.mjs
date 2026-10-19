import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
} from "node:crypto";

export function createTailCapture(limit = 2 * 1024 * 1024) {
  const buffer = Buffer.alloc(limit);
  let cursor = 0;
  let used = 0;
  return {
    append(chunk) {
      if (chunk.length >= limit) {
        chunk.copy(buffer, 0, chunk.length - limit);
        cursor = 0;
        used = limit;
        return;
      }
      const first = Math.min(chunk.length, limit - cursor);
      chunk.copy(buffer, cursor, 0, first);
      chunk.copy(buffer, 0, first);
      cursor = (cursor + chunk.length) % limit;
      used = Math.min(limit, used + chunk.length);
    },
    bytes() {
      return used < limit
        ? buffer.subarray(0, used)
        : Buffer.concat([buffer.subarray(cursor), buffer.subarray(0, cursor)]);
    },
  };
}

const aad = (stage, keyId) => Buffer.from(JSON.stringify({ schemaVersion: 1, stage, keyId }));

export function encryptDiagnostic(bytes, stage, publicKey) {
  const recipient = publicKey.type === "public" ? publicKey : createPublicKey(publicKey);
  const keyId = createHash("sha256")
    .update(recipient.export({ type: "spki", format: "der" }))
    .digest("hex");
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(stage, keyId));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    schemaVersion: 1,
    stage,
    keyId,
    wrappedKey: publicEncrypt(
      { key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      key,
    ).toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptDiagnostic(packet, privateKey) {
  if (packet.schemaVersion !== 1) throw new Error("Unsupported encrypted diagnostic");
  const key = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(packet.wrappedKey, "base64"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(packet.iv, "base64"));
  decipher.setAAD(aad(packet.stage, packet.keyId));
  decipher.setAuthTag(Buffer.from(packet.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(packet.ciphertext, "base64")),
    decipher.final(),
  ]);
}

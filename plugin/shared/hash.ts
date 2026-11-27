import crypto from "node:crypto";

export const sha256 = (data: crypto.BinaryLike): string => crypto.createHash("sha256").update(data).digest("hex");
export const sha256Bytes = (data: crypto.BinaryLike): Buffer => crypto.createHash("sha256").update(data).digest();

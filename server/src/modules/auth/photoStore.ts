// 공무원증 사진 저장 (SFR-017, SER-015, DAR-012).
// - 서버가 AES-256-GCM 으로 암호화한 뒤 S3 호환 객체 저장소에 올린다. 저장소에는 암호문만 있다
// - 원본 사진은 디스크에 쓰지 않는다 (업로드는 메모리로 받아 바로 암호화)
// - 승인·반려되면 바로 지운다 (DAR-012). 지우는 함수는 가입 승인(SFR-083)이 쓴다
// 저장소는 바꿔 끼울 수 있게 모양(PhotoStore)만 정하고, 테스트는 메모리 저장소를 쓴다.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface ObjectStorage {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export interface PhotoStore {
  // 암호화해서 올리고 저장소 키를 돌려준다 (signup_request.photo_key)
  save(photo: Buffer): Promise<string>;
  // 관리자 확인용. 이미 지워졌으면 null (410 PHOTO_DELETED)
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

const IV_BYTES = 12; // GCM 권장 길이
const TAG_BYTES = 16;

// 저장 형식: [IV 12바이트][인증 태그 16바이트][암호문]. 태그로 파일이 바뀌지 않았는지도 확인한다
export function encryptPhoto(key: Buffer, photo: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(photo), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptPhoto(key: Buffer, stored: Buffer): Buffer {
  const iv = stored.subarray(0, IV_BYTES);
  const tag = stored.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(stored.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

// PHOTO_ENC_KEY: base64 32바이트. 길이가 틀리면 서버가 켜질 때 바로 멈춘다 (나중에 가입이 깨지지 않게)
export function parsePhotoKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('PHOTO_ENC_KEY는 base64로 32바이트여야 해요');
  return key;
}

export function createPhotoStore(storage: ObjectStorage, key: Buffer): PhotoStore {
  return {
    async save(photo) {
      // 키에 대원 정보를 넣지 않는다. 저장소만 봐서는 누구 사진인지 알 수 없다
      const objectKey = `signup/${randomUUID()}`;
      await storage.put(objectKey, encryptPhoto(key, photo));
      return objectKey;
    },
    async read(objectKey) {
      const stored = await storage.get(objectKey);
      return stored ? decryptPhoto(key, stored) : null;
    },
    async remove(objectKey) {
      await storage.delete(objectKey);
    },
  };
}

// S3 호환 저장소 (운영: Lightsail 객체 저장소, 개발: docker compose 의 S3Mock)
export function createS3Storage(options: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): ObjectStorage {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    // S3Mock·Lightsail 은 버킷을 주소 경로로 받는다 (bucket.host 방식이 아님)
    forcePathStyle: true,
  });
  const Bucket = options.bucket;
  return {
    async put(Key, Body) {
      await client.send(
        new PutObjectCommand({ Bucket, Key, Body, ContentType: 'application/octet-stream' }),
      );
    },
    async get(Key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key }));
        return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : null;
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return null;
        throw err;
      }
    },
    async delete(Key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key }));
    },
  };
}

// 테스트·저장소 없는 개발용: 메모리에 둔다 (서버 상태로 쓰지 않는다. 운영에서는 쓰지 않음)
export function createMemoryStorage(): ObjectStorage & {
  keys(): string[];
  raw(key: string): Buffer | undefined;
} {
  const objects = new Map<string, Buffer>();
  return {
    async put(key, body) {
      objects.set(key, Buffer.from(body));
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    keys: () => [...objects.keys()],
    raw: (key) => objects.get(key),
  };
}

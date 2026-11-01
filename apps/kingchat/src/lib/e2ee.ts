import nacl from 'tweetnacl';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

export const E2EE_PREFIX = 'KC-E2EE1:';

export type DeviceIdentity = {
  deviceId: string;
  publicKeyHex: string;
  secretKeyHex: string;
};

export type PublicDeviceKey = {
  id: string;
  user_id: string;
  public_key: string;
};

type EncryptedEnvelope = {
  version: 1;
  algorithm: 'X25519-XSalsa20-Poly1305';
  ephemeralPublicKey: string;
  recipients: Record<string, { nonce: string; ciphertext: string }>;
};

// TweetNaCl requests random values synchronously. Expo Crypto delegates this
// to the native OS random-number generator on installed builds.
nacl.setPRNG((target, length) => {
  target.set(Crypto.getRandomBytes(length));
});

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

const fromHex = (value: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error('Invalid cryptographic key encoding.');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const utf8ToBytes = (value: string): Uint8Array => {
  const encoded = encodeURIComponent(value).replace(
    /%([0-9A-F]{2})/g,
    (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))
  );
  return Uint8Array.from(encoded, char => char.charCodeAt(0));
};

const bytesToUtf8 = (bytes: Uint8Array): string =>
  decodeURIComponent(Array.from(bytes, byte => `%${byte.toString(16).padStart(2, '0')}`).join(''));

export async function loadOrCreateDeviceIdentity(
  supabase: any,
  userId: string
): Promise<DeviceIdentity> {
  const secureStoreKey = `kingchat.e2ee.v1.${userId}`;
  let stored = await SecureStore.getItemAsync(secureStoreKey);
  let keyData: { publicKeyHex: string; secretKeyHex: string };

  if (stored) {
    keyData = JSON.parse(stored);
    if (fromHex(keyData.publicKeyHex).length !== nacl.box.publicKeyLength ||
        fromHex(keyData.secretKeyHex).length !== nacl.box.secretKeyLength) {
      throw new Error('This device encryption key is invalid. Sign out and contact support before clearing app data.');
    }
  } else {
    const pair = nacl.box.keyPair();
    keyData = {
      publicKeyHex: toHex(pair.publicKey),
      secretKeyHex: toHex(pair.secretKey)
    };
    await SecureStore.setItemAsync(secureStoreKey, JSON.stringify(keyData));
    pair.secretKey.fill(0);
  }

  const { data: existing, error: lookupError } = await supabase
    .from('kc_e2ee_devices')
    .select('id')
    .eq('user_id', userId)
    .eq('public_key', keyData.publicKeyHex)
    .is('revoked_at', null)
    .maybeSingle();

  if (lookupError) throw lookupError;

  let deviceId = existing?.id as string | undefined;
  if (!deviceId) {
    const { data, error } = await supabase
      .from('kc_e2ee_devices')
      .insert({
        user_id: userId,
        public_key: keyData.publicKeyHex,
        device_label: 'King Chat mobile device'
      })
      .select('id')
      .single();

    if (error) throw error;
    deviceId = data.id;
  }

  return { deviceId, ...keyData };
}

export function encryptMessageForDevices(
  plaintext: string,
  devices: PublicDeviceKey[],
  identity: DeviceIdentity
): string {
  if (!devices.length) throw new Error('No encryption devices are registered in this conversation.');

  const ephemeral = nacl.box.keyPair();
  const recipients: EncryptedEnvelope['recipients'] = {};
  const messageBytes = utf8ToBytes(plaintext);

  try {
    for (const device of devices) {
      const publicKey = fromHex(device.public_key);
      if (publicKey.length !== nacl.box.publicKeyLength) {
        throw new Error('A contact has an invalid encryption key. Ask them to update King Chat.');
      }
      const nonce = Crypto.getRandomBytes(nacl.box.nonceLength);
      const ciphertext = nacl.box(
        messageBytes,
        nonce,
        publicKey,
        ephemeral.secretKey
      );
      recipients[device.id] = {
        nonce: toHex(nonce),
        ciphertext: toHex(ciphertext)
      };
    }

    const envelope: EncryptedEnvelope = {
      version: 1,
      algorithm: 'X25519-XSalsa20-Poly1305',
      ephemeralPublicKey: toHex(ephemeral.publicKey),
      recipients
    };
    return E2EE_PREFIX + JSON.stringify(envelope);
  } finally {
    ephemeral.secretKey.fill(0);
    messageBytes.fill(0);
  }
}

export function decryptMessageForDevice(
  body: string,
  identity: DeviceIdentity
): string {
  if (!body.startsWith(E2EE_PREFIX)) return body;

  const envelope = JSON.parse(body.slice(E2EE_PREFIX.length)) as EncryptedEnvelope;
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== 'X25519-XSalsa20-Poly1305' ||
    !envelope.ephemeralPublicKey ||
    !envelope.recipients
  ) {
    throw new Error('Unsupported encrypted message format.');
  }

  const recipient = envelope.recipients[identity.deviceId];
  if (!recipient) {
    throw new Error('This encrypted message was sent before this device was added, or to a different device.');
  }

  const opened = nacl.box.open(
    fromHex(recipient.ciphertext),
    fromHex(recipient.nonce),
    fromHex(envelope.ephemeralPublicKey),
    fromHex(identity.secretKeyHex)
  );

  if (!opened) throw new Error('Message authentication failed. The message may be corrupted.');
  return bytesToUtf8(opened);
}

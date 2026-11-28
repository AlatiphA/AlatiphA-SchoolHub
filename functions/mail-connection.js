'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;

const email = value => String(value || '').trim().toLowerCase();
const validEmail = value => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value) && value.length <= 254;
const validHost = value => /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);

function publicIPv4(value) {
  const p = value.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  return a > 0 && a < 224 && a !== 10 && a !== 127
    && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && (b === 168 || b === 0 && c === 0 || b === 0 && c === 2))
    && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
    && !(a === 203 && b === 0 && c === 113);
}

function createMailConnection({ db, mailKey, createTransport, resolveAddresses = host => dns.resolve4(host) }) {
  const key = () => {
    const value = Buffer.from(String(mailKey.value() || ''), 'base64');
    if (value.length !== 32) throw new Error('School mail encryption key is unavailable.');
    return value;
  };
  const ref = schoolId => db.collection('schools').doc(schoolId).collection('mailConfig').doc('outgoing');
  const encrypt = (schoolId, password) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(schoolId));
    const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(x => x.toString('base64')).join('.');
  };
  const decrypt = (schoolId, sealed) => {
    const [iv, tag, data] = String(sealed || '').split('.').map(x => Buffer.from(x || '', 'base64'));
    if (iv.length !== 12 || tag.length !== 16 || !data.length) throw new Error('School mail credential is unavailable.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAAD(Buffer.from(schoolId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  };
  const challengeHash = (schoolId, code) => crypto.createHmac('sha256', key()).update(schoolId + ':' + code).digest('hex');
  const transport = async settings => {
    const addresses = await resolveAddresses(settings.host);
    const address = addresses.find(publicIPv4);
    if (!address) throw new Error('The outgoing mail server has no public address.');
    return createTransport({ host: address, port: settings.port, secure: settings.port === 465,
      requireTLS: settings.port === 587, tls: { servername: settings.host, minVersion: 'TLSv1.2' },
      auth: { user: settings.user, pass: settings.password },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  };
  const read = async (schoolId, schoolEmail) => {
    const snap = await ref(schoolId).get();
    if (!snap.exists) return { found: false, status: 'unconfigured', settings: null };
    const data = snap.data() || {};
    if (data.state !== 'active' || email(data.from) !== schoolEmail) {
      return { found: true, status: data.state === 'pending' ? 'pending' : 'unconfigured', settings: null };
    }
    try { return { found: true, status: 'active', settings: { host: data.host, port: data.port,
      user: data.user, from: data.from, password: decrypt(schoolId, data.sealedPassword) } }; }
    catch { return { found: true, status: 'unconfigured', settings: null }; }
  };
  const begin = async (schoolId, schoolEmail, input) => {
    const provider = input?.provider === 'gmail' ? 'gmail' : input?.provider === 'smtp' ? 'smtp' : '';
    const host = provider === 'gmail' ? 'smtp.gmail.com' : String(input?.host || '').trim().toLowerCase();
    const port = provider === 'gmail' ? 465 : Number(input?.port);
    const user = String(input?.user || '').trim();
    const password = String(input?.password || '');
    if (!provider || !validEmail(schoolEmail) || !validHost(host) || ![465, 587].includes(port)
      || !user || user.length > 254 || /[\r\n\0]/.test(user)
      || provider === 'gmail' && email(user) !== schoolEmail
      || !password || password.length > 256 || /[\r\n\0]/.test(password)) {
      throw new Error('Use the school email and valid outgoing mail details.');
    }
    const target = ref(schoolId), previous = await target.get(), now = Date.now();
    if (previous.exists && now - Number(previous.data()?.startedAtMs || 0) < 60000) {
      throw new Error('Wait one minute before requesting another verification code.');
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const mailer = await transport({ host, port, user, password });
    try {
      const result = await mailer.sendMail({ from: schoolEmail, to: schoolEmail,
        subject: 'Verify your SchoolHub school email',
        text: `Your SchoolHub verification code is ${code}. It expires in 15 minutes. Enter it only if this message shows ${schoolEmail} as the sender.` });
      if (!result.accepted?.map(email).includes(schoolEmail)) throw new Error('The school address did not accept the verification email.');
    } finally { mailer.close?.(); }
    await target.set({ state: 'pending', provider, host, port, user, from: schoolEmail,
      sealedPassword: encrypt(schoolId, password), challengeHash: challengeHash(schoolId, code),
      startedAtMs: now, expiresAtMs: now + 15 * 60 * 1000, attempts: 0 });
    return { verificationSent: true, schoolEmail };
  };
  const confirm = async (schoolId, schoolEmail, code) => {
    const target = ref(schoolId), snap = await target.get(), data = snap.data() || {};
    if (!snap.exists || data.state !== 'pending' || email(data.from) !== schoolEmail
      || Date.now() > Number(data.expiresAtMs || 0) || Number(data.attempts || 0) >= 5) {
      throw new Error('Verification expired. Start the connection again.');
    }
    if (!/^\d{6}$/.test(code) || challengeHash(schoolId, code) !== data.challengeHash) {
      await target.update({ attempts: Number(data.attempts || 0) + 1 });
      throw new Error('That verification code is incorrect.');
    }
    await target.update({ state: 'active', challengeHash: null, verifiedAtMs: Date.now() });
    return { configured: true, from: schoolEmail };
  };
  const disconnect = async schoolId => { await ref(schoolId).delete(); return { disconnected: true }; };
  return { read, begin, confirm, disconnect, transport };
}

module.exports = { createMailConnection, publicIPv4 };

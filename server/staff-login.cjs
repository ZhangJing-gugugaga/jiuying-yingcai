'use strict';

const crypto = require('node:crypto');
const core = require('../shared/core.cjs');
const {authProviders, fetchJson} = require('./auth-providers.cjs');

const staffRoles = new Set(['manager', 'ops', 'finance', 'location', 'support', 'regional']);
const purpose = 'staff_login';
const provider = 'wechat-web';
const mobilePattern = /^1[3-9]\d{9}$/;
const statePattern = /^[A-Za-z0-9_-]{32}$/;
const duration = 5 * 60 * 1000;
const keepHistory = 24 * 3600 * 1000;

function canonicalOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.origin === value) return url.origin;
  } catch {
    return null;
  }
  return null;
}

function staffLogin(store, auth, env, fetcher = fetch) {
  const {db} = store;
  const {NODE_ENV, ADAPTER_MODE, WECHAT_WEB_APP_ID: appId, WECHAT_WEB_APP_SECRET: appSecret} = env;
  const suppliedKey = env.IDENTITY_ENCRYPTION_KEY;
  const key = suppliedKey ? Buffer.from(suppliedKey, 'base64')
    : NODE_ENV === 'production' ? null
      : crypto.createHash('sha256').update('jiuying-local-test-only-identity-key').digest();
  const providers = authProviders(env, fetcher);
  const origin = canonicalOrigin(env.PUBLIC_ORIGIN);
  const encryptionReady = key?.length === 32;
  const mockSms = NODE_ENV !== 'production' && ADAPTER_MODE === 'mock' && providers.capabilities.mode === 'mock';
  const capabilities = {
    sms: Boolean(encryptionReady && providers.capabilities.sms && (mockSms || providers.capabilities.mode !== 'mock')),
    wechat: Boolean(encryptionReady && env.WECHAT_WEB_AUTH_ENABLED === '1' && origin
      && /^wx[a-f\d]{16}$/i.test(appId || '') && appSecret),
    mockSms,
  };
  const encrypt = value => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  };
  const hmac = (...parts) => crypto.createHmac('sha256', key).update(JSON.stringify(parts)).digest('hex');
  const secureEqual = (a, b) => crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  const phoneHash = number => hmac('staff-mobile', number);

  function throttle(label, value, max) {
    const rateKey = label + ':' + hmac(value || 'local');
    auth.rate(rateKey, max);
    auth.failure(rateKey, max);
  }

  function personalStaff(actor, activated = true) {
    const record = db.prepare(
      'SELECT u.role,u.binding_version,c.actor AS activated FROM users u JOIN staffAccounts s ON s.id=u.actor '
      + 'LEFT JOIN credentials c ON c.actor=u.actor WHERE u.actor=? AND u.status=? AND s.status=?'
    ).get(actor || '', 'active', 'active');
    if (!record || !staffRoles.has(record.role) || (activated && !record.activated)) return null;
    return {actor, binding: record.binding_version};
  }

  function requireStaff(actor, activated = true) {
    const staff = personalStaff(actor, activated);
    core.check(staff, 'FORBIDDEN', activated ? '请先激活个人总部账号' : '总部个人账号不可用', 403);
    return staff;
  }

  function profile(who, actor) {
    core.check(!actor || actor === who.principal || who.role === 'manager', 'FORBIDDEN', '当前账号无权查看此登录设置', 403);
    const staff = requireStaff(actor || who.principal, !actor || actor === who.principal);
    const stored = db.prepare('SELECT phone_masked FROM staff_login_mobiles WHERE actor=?').get(staff.actor);
    const bound = encryptionReady && capabilities.wechat && db.prepare(
      'SELECT 1 FROM identity_bindings WHERE actor=? AND provider=? AND binding_version=? AND external_hash LIKE ?'
    ).get(staff.actor, provider, staff.binding, appId + ':%');
    return {smsMobileMasked: stored ? stored.phone_masked : null, wechatBound: Boolean(bound)};
  }

  async function configureMobile(who, input, reauth, requestId) {
    core.check(who.role === 'manager', 'FORBIDDEN', '仅总管理员可登记个人登录手机号', 403);
    requireStaff(who.principal);
    requireStaff(input.actor, false);
    core.check(encryptionReady, 'CONFIG', '尚未配置服务端身份加密密钥', 503);
    core.check(typeof input.mobile === 'string' && (input.mobile === '' || mobilePattern.test(input.mobile)), 'INPUT', '请输入有效的11位手机号，或明确清除登记');
    await auth.verifyOwnPassword(who, input.password);
    const digest = input.mobile ? phoneHash(input.mobile) : null;
    const masked = input.mobile ? input.mobile.slice(0, 3) + '****' + input.mobile.slice(-4) : null;
    return store.transaction(() => {
      reauth();
      requireStaff(input.actor, false);
      const old = db.prepare('SELECT phone_hash FROM staff_login_mobiles WHERE actor=?').get(input.actor);
      if ((old?.phone_hash || null) === digest) return {smsMobileMasked: masked, changed: false};
      if (digest) {
        const duplicate = db.prepare('SELECT actor FROM staff_login_mobiles WHERE phone_hash=?').get(digest);
        core.check(!duplicate || duplicate.actor === input.actor, 'DUPLICATE', '此号码已登记给其他总部账号', 409);
        db.prepare('INSERT INTO staff_login_mobiles VALUES(?,?,?,?) ON CONFLICT(actor) DO UPDATE SET '
          + 'phone_hash=excluded.phone_hash,phone_masked=excluded.phone_masked,updated_at=excluded.updated_at')
          .run(input.actor, digest, masked, new Date().toISOString());
      } else db.prepare('DELETE FROM staff_login_mobiles WHERE actor=?').run(input.actor);
      auth.revoke(input.actor);
      db.prepare('DELETE FROM identity_bindings WHERE provider=? AND actor=?').run(provider, input.actor);
      auth.event(who.subject, 'auth.staff.mobile.changed', {targetActor: input.actor, requestId});
      return {smsMobileMasked: masked, changed: true};
    });
  }

  async function sendSms(input, ip) {
    core.check(capabilities.sms, 'REAL_ADAPTER_UNAVAILABLE', '总部短信登录暂未开放', 503);
    core.check(typeof input.mobile === 'string' && mobilePattern.test(input.mobile), 'INPUT', '请输入有效的11位手机号');
    throttle('staff-sms-ip', ip, 20);
    const digest = phoneHash(input.mobile), now = Date.now();
    const last = db.prepare('SELECT created_at FROM sms_challenges WHERE phone_hash=? AND purpose=? ORDER BY created_at DESC LIMIT 1')
      .get(digest, purpose);
    core.check(!last || now - last.created_at >= 60000, 'RATE_LIMIT', '请60秒后再获取验证码', 429);
    throttle('staff-sms-number', digest, 5);
    const registered = db.prepare('SELECT actor FROM staff_login_mobiles WHERE phone_hash=?').get(digest);
    const staff = personalStaff(registered?.actor);
    const id = 'sms-' + crypto.randomUUID();
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare('DELETE FROM sms_challenges WHERE expires_at<?').run(now - keepHistory);
    db.prepare('INSERT INTO sms_challenges(id,phone_hash,actor,binding_version,code_hash,status,created_at,expires_at,purpose) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, digest, staff?.actor || null, staff?.binding || null, hmac('staff-sms', id, code), 'sending', now, now + duration, purpose);
    try {
      if (staff) await providers.sms(input.mobile, code);
      db.prepare('UPDATE sms_challenges SET status=? WHERE id=?').run('sent', id);
    } catch (error) {
      db.prepare('UPDATE sms_challenges SET status=? WHERE id=?').run('failed', id);
      throw error;
    }
    return {challengeId: id, expiresIn: 300, resendAfter: 60, ...(mockSms && staff ? {devCode: code} : {})};
  }

  function verifySms(input, ip, requestId) {
    core.check(capabilities.sms, 'REAL_ADAPTER_UNAVAILABLE', '总部短信登录暂未开放', 503);
    throttle('staff-sms-verify', ip, 60);
    const invalid = '验证码无效或账号状态已变化';
    core.check(typeof input.mobile === 'string' && mobilePattern.test(input.mobile)
      && typeof input.code === 'string' && /^\d{6}$/.test(input.code)
      && typeof input.challengeId === 'string' && input.challengeId.length <= 100, 'INVALID_CODE', invalid, 401);
    const row = db.prepare('SELECT * FROM sms_challenges WHERE id=? AND purpose=?').get(input.challengeId, purpose);
    core.check(row && row.status === 'sent' && !row.used_at && row.attempts < 5 && row.expires_at > Date.now(),
      'INVALID_CODE', invalid, 401);
    const attempted = db.prepare('UPDATE sms_challenges SET attempts=attempts+1 WHERE id=? AND used_at IS NULL AND attempts<5').run(row.id);
    core.check(attempted.changes === 1, 'INVALID_CODE', invalid, 401);
    const digest = phoneHash(input.mobile);
    const registered = db.prepare('SELECT actor FROM staff_login_mobiles WHERE phone_hash=?').get(digest);
    const staff = personalStaff(row.actor);
    core.check(secureEqual(row.code_hash, hmac('staff-sms', row.id, input.code)) && row.phone_hash === digest
      && staff && staff.actor === registered?.actor && staff.binding === row.binding_version, 'INVALID_CODE', invalid, 401);
    return store.transaction(() => {
      const fresh = personalStaff(staff.actor);
      const currentMobile = db.prepare('SELECT phone_hash FROM staff_login_mobiles WHERE actor=?').get(staff.actor);
      core.check(fresh?.binding === row.binding_version && currentMobile?.phone_hash === digest, 'INVALID_CODE', invalid, 401);
      const updated = db.prepare('UPDATE sms_challenges SET used_at=? WHERE id=? AND used_at IS NULL').run(Date.now(), row.id);
      core.check(updated.changes === 1, 'INVALID_CODE', invalid, 401);
      auth.event(staff.actor, 'auth.staff.sms.login', {requestId});
      return auth.session(staff.actor);
    });
  }

  function websiteAvailable() {
    core.check(capabilities.wechat, 'REAL_ADAPTER_UNAVAILABLE', '总部微信登录暂未开放', 503);
  }

  function startWechat(ip, staff = null) {
    websiteAvailable();
    throttle('staff-wechat-start', ip, 30);
    const state = crypto.randomBytes(24).toString('base64url'), claim = crypto.randomBytes(24).toString('base64url');
    db.prepare('DELETE FROM staff_wechat_challenges WHERE expires_at<?').run(Date.now() - keepHistory);
    db.prepare('INSERT INTO staff_wechat_challenges(state_hash,claim_hash,scope,actor,binding_version,expires_at) VALUES(?,?,?,?,?,?)')
      .run(hmac('state', state), hmac('claim', claim), appId, staff?.actor || null, staff?.binding || null, Date.now() + duration);
    const url = new URL('https://open.weixin.qq.com/connect/qrconnect');
    url.search = new URLSearchParams({
      appid: appId, redirect_uri: origin + '/', response_type: 'code', scope: 'snsapi_login', state,
    }).toString();
    url.hash = 'wechat_redirect';
    return {authorizationUrl: url.href, claim, expiresIn: 300};
  }

  async function beginBinding(who, input, ip, reauth) {
    websiteAvailable();
    const original = requireStaff(who.principal);
    await auth.verifyOwnPassword(who, input.password);
    reauth();
    const current = requireStaff(who.principal);
    core.check(current.binding === original.binding, 'CONFLICT', '账号权限已变化，请重新登录', 409);
    return startWechat(ip, current);
  }

  async function finishWechat(input, ip, reauth, requestId) {
    websiteAvailable();
    throttle('staff-wechat-finish', ip, 60);
    const invalid = '微信授权已失效，请从当前浏览器重新发起';
    core.check(typeof input.state === 'string' && statePattern.test(input.state)
      && typeof input.claim === 'string' && statePattern.test(input.claim)
      && typeof input.code === 'string' && input.code.length > 0 && input.code.length <= 256,
      'WECHAT_FLOW_INVALID', invalid, 401);
    const stateHash = hmac('state', input.state);
    const flow = db.prepare('SELECT * FROM staff_wechat_challenges WHERE state_hash=?').get(stateHash);
    core.check(flow && flow.scope === appId && !flow.consumed_at && flow.expires_at > Date.now()
      && secureEqual(flow.claim_hash, hmac('claim', input.claim)), 'WECHAT_FLOW_INVALID', invalid, 401);
    const checkBinder = () => {
      const current = reauth();
      core.check(current.principal === flow.actor && requireStaff(current.principal).binding === flow.binding_version,
        'FORBIDDEN', '请使用发起绑定的个人总部账号', 403);
    };
    if (flow.actor) checkBinder();
    const codeHash = hmac('website-code', appId, input.code);
    store.transaction(() => {
      const prior = db.prepare('SELECT 1 FROM staff_wechat_challenges WHERE code_hash=?').get(codeHash);
      core.check(!prior, 'WECHAT_FLOW_INVALID', invalid, 401);
      const used = db.prepare('UPDATE staff_wechat_challenges SET consumed_at=?,code_hash=? WHERE state_hash=? AND consumed_at IS NULL')
        .run(Date.now(), codeHash, stateHash);
      core.check(used.changes === 1, 'WECHAT_FLOW_INVALID', invalid, 401);
    });

    const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
    url.search = new URLSearchParams({appid: appId, secret: appSecret, code: input.code, grant_type: 'authorization_code'}).toString();
    const result = await fetchJson(fetcher, url);
    core.check(!result.errcode, 'WECHAT_CODE_INVALID', '微信授权已失效，请重新扫码', 401);
    core.check(typeof result.openid === 'string' && result.openid.length >= 6 && result.openid.length <= 128
      && typeof result.access_token === 'string' && result.access_token.length > 0, 'PROVIDER_RESPONSE', '微信身份响应不完整', 502);
    const externalHash = appId + ':' + hmac(provider, appId, result.openid);
    return store.transaction(() => {
      const binding = db.prepare('SELECT actor,binding_version FROM identity_bindings WHERE provider=? AND external_hash=?')
        .get(provider, externalHash);
      if (flow.actor) {
        checkBinder();
        core.check(!binding || binding.actor === flow.actor, 'IDENTITY_BOUND', '该微信已绑定另一总部账号，请联系总管理员', 409);
        db.prepare('DELETE FROM identity_bindings WHERE provider=? AND actor=?').run(provider, flow.actor);
        db.prepare('INSERT INTO identity_bindings VALUES(?,?,?,?,?,?)')
          .run(provider, externalHash, flow.actor, flow.binding_version, encrypt(result.openid), new Date().toISOString());
        auth.event(flow.actor, 'auth.staff.wechat.bound', {requestId});
        return {wechatBound: true};
      }
      const staff = personalStaff(binding?.actor);
      core.check(staff && staff.binding === binding.binding_version, 'WECHAT_UNBOUND', '请先登录个人总部账号并绑定微信', 403);
      auth.event(staff.actor, 'auth.staff.wechat.login', {requestId});
      return auth.session(staff.actor);
    });
  }

  return {capabilities, profile, configureMobile, sendSms, verifySms, startWechat, beginBinding, finishWechat};
}

module.exports = {staffLogin};
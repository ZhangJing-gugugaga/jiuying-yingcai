const personalRoles = new Set(['manager', 'ops', 'finance', 'location', 'support', 'regional']);
const flowKey = 'jy-staff-wechat-flow';
const identityEndpoint = '/auth/staff';

function isPersonalStaff(session) {
  return personalRoles.has(session?.role || session?.actor) && session.subject && session.subject !== session.actor;
}

export function staffLoginUi({api, form, field, button, notice, pair, submit, modal, config, session, toast, resetSession}) {
  let sms = null;
  const post = (path, body) => api(identityEndpoint + path, {method: 'POST', body, ignoreUnauthorized: true});

  function tabs() {
    const flags = config().staffLogin || {};
    return [...(flags.sms ? [['staff-sms', '总部手机验证码']] : []), ...(flags.wechat ? [['staff-wechat', '总部微信扫码']] : [])];
  }

  function loginForm(mode) {
    if (mode === 'staff-wechat') {
      return form('staff-wechat-start', notice('请使用已绑定总部账号的微信扫码。首次绑定可先用个人账号登录。')
        + submit('打开微信扫码登录'));
    }
    if (mode === 'staff-sms') {
      return form('staff-sms-login',
        field('mobile', '总部已登记的登录手机号', '', 'tel', 'required pattern="1[3-9][0-9]{9}" maxlength="11" autocomplete="tel"')
        + field('code', '短信验证码', '', 'text', 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"')
        + button('获取短信验证码', 'staff-sms-send')
        + '<p data-staff-sms-feedback class="muted" role="status"></p>'
        + submit('验证并登录'));
    }
    return '';
  }

  async function sendSms(trigger) {
    const f = trigger.closest('form');
    const mobile = f?.elements.mobile.value.trim() || '';
    if (!/^1[3-9][0-9]{9}$/.test(mobile)) throw Error('请输入总部登记的11位手机号。');
    if (sms?.mobile === mobile && Date.now() < sms.deadline) throw Error('请在上次获取验证码60秒后重试。');
    const feedback = f.querySelector('[data-staff-sms-feedback]');
    trigger.disabled = true;
    feedback.textContent = '正在获取验证码…';
    try {
      const result = await post('/sms/send', {mobile});
      if (!f.isConnected || f.elements.mobile.value.trim() !== mobile) {
        sms = null;
        return;
      }
      sms = {mobile, challengeId: result.challengeId, deadline: Date.now() + result.resendAfter * 1000};
      feedback.textContent = config().staffLogin?.mockSms && result.devCode
        ? '本地测试验证码 ' + result.devCode + '。未实际发送短信。'
        : '如该号码已登记并激活，请查收短信。';
      f.elements.code.focus();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      trigger.disabled = false;
    }
  }

  async function verifySms({mobile, code}) {
    const number = mobile.trim();
    if (!sms || number !== sms.mobile || !/^\d{6}$/.test(code.trim())) throw Error('请先为此手机号获取验证码，并填写6位验证码。');
    const result = await post('/sms/verify', {mobile: number, code: code.trim(), challengeId: sms.challengeId});
    sms = null;
    return result;
  }

  async function beginWechat(password) {
    const started = await post(password === undefined ? '/wechat/start' : '/wechat/bind', password === undefined ? {} : {password});
    const target = new URL(started.authorizationUrl);
    if (target.origin !== 'https://open.weixin.qq.com' || target.pathname !== '/connect/qrconnect') throw Error('微信授权地址无效。');
    sessionStorage.setItem(flowKey, JSON.stringify({
      claim: started.claim,
      state: target.searchParams.get('state'),
      expiresAt: Date.now() + started.expiresIn * 1000,
    }));
    location.assign(target.href);
  }

  function takeCallback() {
    const url = new URL(location.href);
    if (!url.searchParams.has('state') || !['code', 'error', 'errcode'].some(key => url.searchParams.has(key))) return null;
    const callback = {code: url.searchParams.get('code'), state: url.searchParams.get('state')};
    for (const key of ['code','state','error','errcode','error_description']) url.searchParams.delete(key);
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    return callback;
  }

  async function finishWechat(callback) {
    if (!callback) return null;
    let record;
    try {
      record = JSON.parse(sessionStorage.getItem(flowKey) || 'null');
    } finally {
      sessionStorage.removeItem(flowKey);
    }
    if (!record || record.expiresAt < Date.now() || record.state !== callback.state) throw Error('微信授权已失效，请从当前浏览器重新发起。');
    if (!callback.code) throw Error('微信授权已取消，可重新发起扫码。');
    return post('/wechat/finish', {...callback, claim: record.claim});
  }

  async function myProfile() {
    const result = await api(identityEndpoint + '/profile');
    const formBody = config().staffLogin?.wechat ? form('staff-wechat-bind',
      notice('在微信中确认后，将此微信绑定到当前总部账号。绑定需要再次验证个人密码。')
      + field('password', '当前个人密码', '', 'password', 'required autocomplete="current-password" maxlength="128"')
      + submit(result.wechatBound ? '重新绑定微信' : '绑定扫码登录微信')) : notice('总部微信扫码登录暂未开通。');
    modal('个人登录安全', pair('登录手机号', result.smsMobileMasked || '待总管理员登记')
      + pair('扫码登录微信', result.wechatBound ? '已绑定' : '未绑定') + formBody);
  }

  async function manageMobile(actor) {
    const result = await api(identityEndpoint + '/profile?' + new URLSearchParams({actor}));
    modal('登记总部登录手机号', pair('个人账号', actor) + pair('当前登记', result.smsMobileMasked || '尚未登记')
      + notice('变更会使原登录会话和微信绑定失效。此手机号用于个人登录。')
      + form('staff-mobile-configure',
        field('actor', '', actor, 'hidden')
        + field('mobile', '新登录手机号', '', 'tel', 'pattern="1[3-9][0-9]{9}" maxlength="11" autocomplete="off"')
        + '<label class="field"><span>清除登录手机号</span><input type="checkbox" name="clear" value="yes"></label>'
        + field('password', '你的个人管理账号密码', '', 'password', 'required autocomplete="current-password" maxlength="128"')
        + submit('确认更新')));
  }

  async function configureMobile(values) {
    const mobile = values.mobile.trim();
    const clear = values.clear === 'yes';
    if (clear === Boolean(mobile)) throw Error('请填写新号码或勾选清除登录手机号。');
    const result = await post('/mobile', {actor:values.actor, mobile, password:values.password});
    if (result.changed && values.actor === session()?.subject) {
      resetSession();
      toast('登录手机号已更新。请重新登录。');
      return;
    }
    modal('已核对登录手机号', pair('个人账号', values.actor) + pair('当前登记', result.smsMobileMasked || '已清除')
      + notice(result.changed ? '号码已更新。请通知账号本人重新登录。' : '登记信息与当前记录一致。'));
  }

  return {tabs, loginForm, sendSms, verifySms, beginWechat, takeCallback, finishWechat, isPersonalStaff, myProfile, manageMobile, configureMobile};
}
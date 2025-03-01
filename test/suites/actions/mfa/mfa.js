const { strict: assert } = require('assert');
const { authenticator } = require('otplib');
const request = require('request-promise').defaults({
  uri: 'https://ms-users.local/users/_/me',
  json: true,
  gzip: true,
  simple: true,
  strictSSL: false,
});
const { USERS_MFA_FLAG } = require('../../../../src/constants');
const { globalAuthUser, globalRegisterUser, startService, clearRedis } = require('../../../config');

describe('#mfa.*', function activateSuite() {
  // actions supported by this
  const username = 'mfa@me.com';
  const generateRoute = 'mfa.generate-key';
  const attachRoute = 'mfa.attach';
  const verifyRoute = 'mfa.verify';
  const regenerateRoute = 'mfa.regenerate-codes';
  const detachRoute = 'mfa.detach';
  const user = { username, password: '123', audience: '*.localhost' };

  const errToValidate = (fn) => (err) => {
    try {
      fn(err);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  };

  function totpIsInvalid(error) {
    assert.equal(error.name, 'HttpStatusError');
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'E_TOTP_INVALID');
    assert.ok(/TOTP invalid/.test(error.message), error.message);
  }

  function totpIsRequired(error) {
    assert.equal(error.name, 'HttpStatusError');
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'E_TOTP_REQUIRED');
    assert.ok(/TOTP required/.test(error.message), error.message);
  }

  before(startService);
  after(clearRedis);

  // registers user and pushes JWT to this.jwt
  before('register user', globalRegisterUser(username));
  before('auth user', globalAuthUser(username));

  let secret;
  let recoveryCodes;
  let regeneratedCodes;

  describe('#mfa.generate-key', function generateKeySuite() {
    it('rejects invalid time skew key', async function test() {
      await assert.rejects(
        this.users.dispatch(generateRoute, { params: { time: 'bubble' } })
      );
    });

    it('generates key', async function test() {
      const data = await this.users
        .dispatch(generateRoute, { params: { username, time: Date.now() } });

      assert(data.uri, 'must generate uri to be shown');
      assert(typeof data.skew === 'number', 'skew must be present');

      secret = data.secret;
    });
  });

  describe('#mfa.attach', function attachSuite() {
    it('doesn\'t allow to attach if provided totp is invalid', async function test() {
      await assert.rejects(this.users
        .dispatch(attachRoute, { params: { username, secret, totp: '123456' } }), errToValidate(totpIsInvalid));
    });

    it('attaches secret to user account if provided totp is valid', async function test() {
      const { enabled, recoveryCodes: codes } = await this.users
        .dispatch(attachRoute, { params: { username, secret, totp: authenticator.generate(secret) } });

      assert.ok(enabled);
      assert.equal(codes.length, 10);

      // store for future use
      recoveryCodes = codes;
    });

    it('doesn\'t allow to attach if already attached', async function test() {
      await assert.rejects(this.users
        .dispatch(attachRoute, { params: { username, secret, totp: authenticator.generate(secret) } }), {
        name: 'HttpStatusError',
        statusCode: 409,
        message: 'MFA already enabled',
      });
    });

    it('returns mfa info inside user\'s metadata', async function test() {
      const res = await request.get({
        headers: { authorization: `JWT ${this.jwt}` },
      });

      assert.equal(res[USERS_MFA_FLAG], true);
    });

    it('rejects login attempt with enabled mfa', async function test() {
      await assert.rejects(this.users
        .dispatch('login', { params: user }), errToValidate(totpIsRequired));
    });

    it('login succeeds (header totp)', async function test() {
      const login = await this.users
        .dispatch('login', { params: user, headers: { 'x-auth-totp': authenticator.generate(secret) } });

      assert.ok(login);
    });

    it('login succeeds (params totp)', async function test() {
      const login = await this.users
        .dispatch('login', { params: { ...user, totp: authenticator.generate(secret) } });

      assert.ok(login);
    });
  });

  describe('#mfa.verify', function verifySuite() {
    it('throws if invalid totp is provided', async function test() {
      await assert.rejects(this.users
        .dispatch(verifyRoute, { params: { username, totp: '123456' } }), errToValidate(totpIsInvalid));
    });

    it('doesn\'t throw if valid totp is provided', async function test() {
      const { valid } = await this.users
        .dispatch(verifyRoute, { params: { username, totp: authenticator.generate(secret) } });

      assert.ok(valid);
    });

    it('doesn\'t throw if valid recovery code is provided', async function test() {
      const { valid } = await this.users
        .dispatch(verifyRoute, { params: { username, totp: recoveryCodes[0] } });

      assert.ok(valid);
    });

    it('throws if same recovery code provided one more time', async function test() {
      await assert.rejects(this.users
        .dispatch(verifyRoute, { params: { username, totp: recoveryCodes[0] } }), errToValidate(totpIsInvalid));

      // finally remove used code
      recoveryCodes = recoveryCodes.slice(1);
    });
  });

  describe('#mfa.regenerate-codes', function regenerateSuite() {
    it('doesn\'t allow to regenerate codes if invalid totp is provided', async function test() {
      await assert.rejects(this.users
        .dispatch(regenerateRoute, { params: { username, totp: '123456' } }), errToValidate(totpIsInvalid));
    });

    it('allows to regenerate codes if valid totp is provided', async function test() {
      const { regenerated, recoveryCodes: codes } = await this.users
        .dispatch(regenerateRoute, { params: { username, totp: authenticator.generate(secret) } });

      assert.ok(regenerated);
      assert.equal(codes.length, 10);

      // store new codes
      regeneratedCodes = codes;
    });

    it('throws if some old recovery code is provided', async function test() {
      await assert.rejects(this.users
        .dispatch(verifyRoute, { params: { username, totp: recoveryCodes[0] } }), errToValidate(totpIsInvalid));
    });

    it('doesn\'t throw if new valid recovery is provided', async function test() {
      const { valid } = await this.users
        .dispatch(verifyRoute, { params: { username, totp: regeneratedCodes[0] } });

      assert.ok(valid);
      // remove used code
      regeneratedCodes = regeneratedCodes.slice(1);
    });
  });

  describe('#mfa.detach', function detachSuite() {
    it('doesn\'t allow to detach if invalid totp is provided', async function test() {
      await assert.rejects(this.users
        .dispatch(detachRoute, { params: { username, totp: '123456' } }), errToValidate(totpIsInvalid));
    });

    it('allows to detach if valid totp is provided', async function test() {
      const { enabled } = await this.users
        .dispatch(detachRoute, { params: { username, totp: authenticator.generate(secret) } });

      assert.equal(enabled, false);
    });

    it('doesn\'t allow to detach if not attached', async function test() {
      await assert.rejects(this.users
        .dispatch(detachRoute, { params: { username, totp: authenticator.generate(secret) } }), {
        name: 'HttpStatusError',
        statusCode: 412,
        message: 'MFA disabled',
      });
    });

    it('sets mfa flag to false after detaching', async function test() {
      const res = await request.get({
        headers: { authorization: `JWT ${this.jwt}` },
      });

      assert.equal(res[USERS_MFA_FLAG], false);
    });
  });
});

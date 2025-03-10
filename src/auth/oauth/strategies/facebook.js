const Crypto = require('crypto');
const { strict: assert } = require('assert');
const Boom = require('@hapi/boom');
const { fetch } = require('undici');
const differenceWith = require('lodash/differenceWith');
const defaults = require('lodash/defaults');
const { HttpStatusError } = require('@microfleet/validation');
const Urls = require('../utils/fb-urls');
const get = require('../../../utils/get-value');

const FIELDS = [
  'id',
  'name',
  'email',
  'first_name',
  'last_name',
  'middle_name',
  'link',
  'locale',
  'timezone',
  'updated_time',
  'verified',
  'picture.type(square).width(200).height(200)',
].join(',');

function scopeComparator(scopeValue, fbPermission) {
  return scopeValue === fbPermission.permission && fbPermission.status === 'granted';
}

function defaultProfileHandler(ctx, profile) {
  const { credentials } = ctx;
  const { token, refreshToken } = credentials;
  const { id, email, username } = profile;

  // embed profile, contains only safe data, would be attached to user's metadata
  credentials.profile = {
    id,
    displayName: profile.name,
    age_range: profile.age_range,
    name: {
      first: profile.first_name,
      last: profile.last_name,
      middle: profile.middle_name,
    },
  };

  credentials.raw = profile;

  // if we have actual picture
  if (get(profile, 'picture.data.is_silhouette', { default: true }) === false) {
    credentials.profile.picture = profile.picture.data.url;
  }

  // private data to store
  credentials.internals = {
    id,
    token,
    refreshToken,
    username,
  };

  // inject email directly to credentials
  if (email) {
    credentials.email = email;
    credentials.internals.email = email;
  }

  return credentials;
}

function fetchFactory(resource) {
  const endpoint = Urls.instance()[resource];
  return (fetcher, options, bearer) => fetcher(endpoint, options, bearer);
}

const fetchProfile = fetchFactory('profile');
const fetchPermissions = fetchFactory('permissions');

function verifyPermissions(ctx, permissions) {
  const { credentials, requiredPermissions } = ctx;
  const missingPermissions = differenceWith(
    requiredPermissions,
    permissions.data,
    scopeComparator
  );

  if (missingPermissions.length) {
    credentials.missingPermissions = missingPermissions;
    return false;
  }

  return true;
}

/**
 *
 * @param {Bell#context} ctx - bell auth strategy settings & context
 */
// eslint-disable-next-line default-param-last
const defaultGetterFactory = (ctx) => async (uri, params = {}, bearer) => {
  assert(bearer, 'bearer token must be supplied');

  const reqHeaders = {
    Authorization: `Bearer ${bearer}`,
  };

  if (ctx.profileParams) {
    Object.assign(params, ctx.profileParams);
  }

  if (ctx.provider.headers) {
    Object.assign(reqHeaders, ctx.provider.headers);
  }

  try {
    const url = new URL(uri);
    url.searchParams = new URLSearchParams(params);
    const { statusCode, headers, body } = await fetch(url, {
      method: ctx.provider.profileMethod,
      headers: reqHeaders,
    });

    if (statusCode !== 200) {
      const err = new HttpStatusError(statusCode, await body.text());
      err.headers = headers;
      throw err;
    }

    return await body.json();
  } catch (err) {
    throw Boom.internal(`Failed obtaining ${ctx.name} user profile`, {
      body: err.message,
      headers: err.headers,
      request: {
        uri,
        params,
        headers: reqHeaders,
      },
      stack: err.stack,
    });
  }
};

function profileFactory(fields, profileHandler = defaultProfileHandler) {
  return async function obtainProfile(credentials, params, getter = defaultGetterFactory(this)) {
    const ap = Crypto.createHmac('sha256', this.clientSecret)
      .update(credentials.token)
      .digest('hex');

    const requiredPermissions = get(this, 'provider.scope', { default: [] });
    const ctx = {
      fields,
      credentials,
      requiredPermissions,
    };

    const permissions = await fetchPermissions(getter, { appsecret_proof: ap }, credentials.token);
    verifyPermissions(ctx, permissions);
    const profile = await fetchProfile(getter, { appsecret_proof: ap, fields }, credentials.token);
    return profileHandler(ctx, profile);
  };
}

function transformAccountToResponseFormat(account) {
  // input data
  // TODO: customize what to encode
  const {
    uid,
    provider,
    email,
    profile,
    internals,
  } = account;

  // compose facebook context, would be encoded
  return {
    uid,
    email,
    provider,
    internals,
    profile: {
      ...profile,
    },
  };
}

const defaultOptions = {
  protocol: 'oauth2',
  useParamsAuth: true,
  scope: ['email'],
  scopeSeparator: ',',
  profile: profileFactory(FIELDS),
  auth: Urls.auth,
  token: Urls.token,
  profileMethod: 'get',
};

exports.options = (options) => {
  const { scope, scopeSeparator, apiVersion } = options;

  if (apiVersion) {
    Urls.setVersion(apiVersion);
  }

  const fields = get(options, 'fields', { default: FIELDS });
  const profileHandler = get(options, 'profileHandler', { default: defaultProfileHandler });

  const configuredOptions = {
    scope,
    scopeSeparator,
    auth: Urls.auth,
    token: Urls.token,
    profile: profileFactory(fields, profileHandler),
  };

  return defaults(configuredOptions, defaultOptions);
};

exports.profileFactory = profileFactory;
exports.verifyPermissions = verifyPermissions;
exports.transformAccountToResponseFormat = transformAccountToResponseFormat;

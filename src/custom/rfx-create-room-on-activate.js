const is = require('is');
const Promise = require('bluebird');
const setMetadata = require('../utils/updateMetadata.js');

/**
 * @param  {String} username
 * @param  {Object} params
 * @return {Promise}
 */
function createRoom(username, params, metadata) {
  const { audience, inviteToken } = params;

  if (is.undefined(inviteToken) === true) {
    return Promise.resolve();
  }

  const { amqp, config } = this;
  const { router } = config.chat;
  const route = `${router.prefix}.${router.routes['internal.rooms.create']}`;
  const roomParams = {
    createdBy: username,
    name: `${metadata[audience].station} | ${metadata[audience].scool}`,
  };

  return amqp.publishAndWait(route, roomParams, { timeout: 5000 })
    .bind(this)
    .then(room => {
      const update = {
        username,
        audience,
        metadata: {
          $set: {
            roomId: room.id,
          },
        },
      };

      return setMetadata.call(this, update);
    });
}

module.exports = createRoom;

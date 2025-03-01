const { strict: assert } = require('assert');
const os = require('os');
const { startService, clearRedis } = require('../../config');

const randomIp = `127.0.0.${Math.floor(Math.random() * 250) + 1}`;
const jobId = `${os.hostname()}_test_${randomIp}`;

/**
 * Includes E2E tests for Cloudflare API.
 * Other checks stubbed
 */
describe('#cloudflare.add-to-list action', () => {
  const createdIps = [];
  let usedList;

  /* Restart service before each test to achieve clean database. */
  before('start', async () => {
    await startService.call(this, {
      cfAccessList: {
        enabled: true,
        worker: { enabled: false },
      },
    });
  });

  after('stop', async () => {
    const toDelete = createdIps.map((({ id }) => id));
    if (toDelete.length > 0) {
      await this.users.cfAccessList.cfApi.deleteListItems(usedList, toDelete);
    }
    await clearRedis.call(this, false);
  });

  it('should add ip', async () => {
    usedList = await this.users.dispatch('cf.add-to-access-list', { params: { remoteip: randomIp, comment: jobId } });
    const ips = [];
    const ipsGenerator = this.users.cfAccessList.getListIPsGenerator(usedList);
    for await (const ip of ipsGenerator) {
      ips.push(...ip);
    }
    createdIps.push(...ips.filter(({ comment }) => comment === jobId));
    assert.deepStrictEqual(createdIps.length, 1);
  });

  it('should touch ip', async () => {
    const ips = [];

    await this.users.dispatch('cf.add-to-access-list', { params: { remoteip: randomIp, comment: jobId } });
    const ipsGenerator = this.users.cfAccessList.getListIPsGenerator(usedList);

    for await (const ip of ipsGenerator) {
      ips.push(...ip);
    }

    const filteredIps = ips.filter(({ comment }) => comment === jobId);
    // should contain only 1 IP
    assert.deepStrictEqual(filteredIps.length, 1);
  });
});

const sdk = require('matrix-js-sdk');
const { logger } = require('matrix-js-sdk/lib/logger');
logger.setLevel('warn');

class MatrixClient {
  constructor(homeserver, userId, accessToken, commandManager) {
    this.commandManager = commandManager;
    this.client = sdk.createClient({
      baseUrl: homeserver,
      userId,
      accessToken,
      timelineSupport: true,
    });
  }

  async start() {
    this.client.on('Room.timeline', (event, room) => {
      if (event.getType() !== 'm.room.message') return;
      if (event.getSender() === this.client.getUserId()) return;
      // Only handle events after startup (avoid replaying history)
      if (event.getAge && event.getAge() > 10000) return;
      this.commandManager.handleMessage(event, room, this.client);
    });

    await this.client.startClient({ initialSyncLimit: 0 });
    console.log(`[matrix] Connected as ${this.client.getUserId()}`);
  }

  getClient() {
    return this.client;
  }
}

module.exports = MatrixClient;

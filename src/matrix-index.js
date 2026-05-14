require('dotenv').config();
const WebUI               = require('./WebUI');
const RoomManager         = require('./RoomManager');
const MatrixCommandManager = require('./MatrixCommandManager');
const MatrixClient        = require('./MatrixClient');
const LiveKitManager      = require('./LiveKitManager');
const MatrixAsrClient     = require('./MatrixAsrClient');

const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix.hackatoa.com';
const MATRIX_USER_ID    = process.env.MATRIX_USER_ID    || '';
const MATRIX_TOKEN      = process.env.MATRIX_TOKEN      || '';

if (!MATRIX_TOKEN) {
  console.error('MATRIX_TOKEN is not set. Bot will not start.');
  process.exit(1);
}

const webUI          = new WebUI();
const commandManager = new MatrixCommandManager(null); // roomManager set below
const matrixClient   = new MatrixClient(MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_TOKEN, commandManager);
const client         = matrixClient.getClient();

const roomManager    = new RoomManager(client, webUI);
const livekitManager = new LiveKitManager(roomManager);
const asrClient      = new MatrixAsrClient(webUI, roomManager);

// Wire up cross-references
commandManager.roomManager = roomManager;
roomManager.livekitManager  = livekitManager;
roomManager.asrClient       = asrClient;

// Handle voice clip trigger from ASR (needs client ref)
webUI.on?.('voice_clip_trigger', async ({ roomId, userId }) => {
  await roomManager.handleClipCommand(roomId, userId, userId, null, null, roomId, client);
});

// Watch for Element Call state events to join/leave LiveKit rooms
client.on('event', async (event) => {
  // MSC3401 / Element Call: m.call.member events signal active calls
  if (event.getType() === 'm.call.member') {
    const roomId  = event.getRoomId();
    const content = event.getContent();
    const hasCall = content?.['m.calls']?.length > 0;

    if (hasCall && !livekitManager.isInRoom(roomId)) {
      console.log(`[call] Call started in ${roomId}, joining LiveKit`);
      await livekitManager.joinRoom(roomId);
      const state = roomManager.getRoomState(roomId);
      state.currentCallRoomId = roomId;
    } else if (!hasCall && livekitManager.isInRoom(roomId)) {
      console.log(`[call] Call ended in ${roomId}, leaving LiveKit`);
      await livekitManager.leaveRoom(roomId);
    }
  }
});

webUI.start();

(async () => {
  await matrixClient.start();
  console.log('[terryvis-matrix] Ready.');
})();

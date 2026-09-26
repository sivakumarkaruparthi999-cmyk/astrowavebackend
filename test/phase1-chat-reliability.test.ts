import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { io as Client, Socket } from 'socket.io-client';
import crypto from 'node:crypto';

const API_BASE = 'http://localhost:5001';
const SOCKET_URL = 'http://localhost:5001';

interface MessagePayload {
  id: string;
  _id?: string;
  consultationId: string;
  senderId?: string;
  senderRole?: string;
  sender?: string;
  content: string;
  text: string;
  createdAt?: string;
  timestamp?: string;
}

function waitForConnect(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('Phase 1: Chat Reliability Tests', () => {
  const consultationId = `test-phase1-${crypto.randomUUID()}`;
  let userSocket: Socket;
  let astroSocket: Socket;

  before(async () => {
    userSocket = Client(SOCKET_URL, { transports: ['websocket'], forceNew: true });
    astroSocket = Client(SOCKET_URL, { transports: ['websocket'], forceNew: true });

    await Promise.all([waitForConnect(userSocket), waitForConnect(astroSocket)]);

    // Both join the consultation room
    userSocket.emit('join_consultation', { consultationId, role: 'customer' });
    astroSocket.emit('join_consultation', { consultationId, role: 'astrologer' });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(() => {
    if (userSocket) userSocket.disconnect();
    if (astroSocket) astroSocket.disconnect();
  });

  it('A. User → Astrologer: sends message, received on socket, persisted in MongoDB', async () => {
    const msgId = crypto.randomUUID();
    const content = 'Hello Astrologer from User';

    const receivePromise = new Promise<MessagePayload>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Receive timeout User -> Astrologer')), 5000);
      const handler = (data: any) => {
        if (data.id === msgId || data._id === msgId) {
          clearTimeout(timer);
          astroSocket.off('new_message', handler);
          resolve(data);
        }
      };
      astroSocket.on('new_message', handler);
    });

    userSocket.emit('send_message', {
      id: msgId,
      consultationId,
      senderId: 'user-001',
      sender: 'customer',
      senderRole: 'customer',
      text: content,
      content,
    });

    const received = await receivePromise;
    assert.strictEqual(received.content, content);
    assert.strictEqual(received.id, msgId);

    // Verify persisted in MongoDB
    const res = await fetch(`${API_BASE}/api/chat/messages/${consultationId}`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.success, true);
    const found = json.data.find((m: any) => (m.id === msgId || m._id === msgId));
    assert.ok(found, 'Message must be found in MongoDB persistent history');
    assert.strictEqual(found.text, content);
  });

  it('B. Astrologer → User: sends message, received on socket, persisted in MongoDB', async () => {
    const msgId = crypto.randomUUID();
    const content = 'Namaste, welcome to the consultation';

    const receivePromise = new Promise<MessagePayload>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Receive timeout Astrologer -> User')), 5000);
      const handler = (data: any) => {
        if (data.id === msgId || data._id === msgId) {
          clearTimeout(timer);
          userSocket.off('new_message', handler);
          resolve(data);
        }
      };
      userSocket.on('new_message', handler);
    });

    astroSocket.emit('send_message', {
      id: msgId,
      consultationId,
      senderId: 'astro-001',
      sender: 'astrologer',
      senderRole: 'astrologer',
      text: content,
      content,
    });

    const received = await receivePromise;
    assert.strictEqual(received.content, content);
    assert.strictEqual(received.id, msgId);

    // Verify persisted in MongoDB
    const res = await fetch(`${API_BASE}/api/chat/messages/${consultationId}`);
    const json = await res.json();
    const found = json.data.find((m: any) => (m.id === msgId || m._id === msgId));
    assert.ok(found, 'Astrologer message must be in MongoDB persistent history');
  });

  it('C. Repeated messages: "hi", "hi", "hi", "hi" with unique IDs must ALL remain', async () => {
    const count = 4;
    const ids: string[] = [];

    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      userSocket.emit('send_message', {
        id,
        consultationId,
        senderId: 'user-001',
        sender: 'customer',
        senderRole: 'customer',
        text: 'hi',
        content: 'hi',
      });
      await new Promise((r) => setTimeout(r, 60));
    }

    // Wait for MongoDB writes to complete
    await new Promise((r) => setTimeout(r, 400));

    // Fetch history
    const res = await fetch(`${API_BASE}/api/chat/messages/${consultationId}`);
    const json = await res.json();
    const hiMessages = json.data.filter((m: any) => ids.includes(m.id || m._id));
    assert.strictEqual(hiMessages.length, 4, 'All 4 repeated "hi" messages must be persisted in MongoDB');

    // Simulate Client-side deduplication ONLY by message ID:
    const localStore: Map<string, any> = new Map();
    for (const msg of hiMessages) {
      localStore.set(msg.id || msg._id, msg);
    }
    assert.strictEqual(localStore.size, 4, 'All 4 repeated "hi" messages must remain after ID deduplication');
  });

  it('D. Rapid messages: 1 through 10 arrive, all remain, sorted chronologically', async () => {
    const rapidIds: string[] = [];

    for (let i = 1; i <= 10; i++) {
      const id = crypto.randomUUID();
      rapidIds.push(id);
      userSocket.emit('send_message', {
        id,
        consultationId,
        senderId: 'user-001',
        sender: 'customer',
        senderRole: 'customer',
        text: `${i}`,
        content: `${i}`,
      });
      await new Promise((r) => setTimeout(r, 30));
    }

    // Wait for writes
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${API_BASE}/api/chat/messages/${consultationId}`);
    const json = await res.json();
    const rapidMsgs = json.data.filter((m: any) => rapidIds.includes(m.id || m._id));
    assert.strictEqual(rapidMsgs.length, 10, 'All 10 rapid messages must exist in MongoDB history');

    // Verify chronological order
    const texts = rapidMsgs.map((m: any) => m.text);
    const expectedTexts = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
    assert.deepStrictEqual(texts, expectedTexts, 'Rapid messages must be ordered chronologically');
  });

  it('E. Reconnect recovery: User disconnects, Astrologer sends 3 messages, User reconnects and recovers all without duplicates in chronological order', async () => {
    // 1. Snapshot existing messages on User
    const resInitial = await fetch(`${API_BASE}/api/chat/messages/${consultationId}`);
    const initialData = (await resInitial.json()).data;
    const clientMessagesMap = new Map<string, any>();
    for (const msg of initialData) {
      clientMessagesMap.set(msg.id || msg._id, msg);
    }

    // 2. Disconnect User socket
    userSocket.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // 3. While User is disconnected, Astrologer sends MISSED_MESSAGE_001, MISSED_MESSAGE_002, MISSED_MESSAGE_003
    const missedTexts = ['MISSED_MESSAGE_001', 'MISSED_MESSAGE_002', 'MISSED_MESSAGE_003'];
    const missedIds: string[] = [];

    for (const text of missedTexts) {
      const id = crypto.randomUUID();
      missedIds.push(id);
      astroSocket.emit('send_message', {
        id,
        consultationId,
        senderId: 'astro-001',
        sender: 'astrologer',
        senderRole: 'astrologer',
        text,
        content: text,
      });
      await new Promise((r) => setTimeout(r, 60));
    }

    await new Promise((r) => setTimeout(r, 400));

    // 4. Reconnect User socket
    userSocket = Client(SOCKET_URL, { transports: ['websocket'], forceNew: true });
    await waitForConnect(userSocket);
    userSocket.emit('join_consultation', { consultationId, role: 'customer' });

    // 5. Fetch persistent history on reconnect
    const resRecon = await fetch(`${API_BASE}/api/chat/messages/${consultationId}`);
    assert.strictEqual(resRecon.status, 200);
    const reconData = (await resRecon.json()).data;

    // 6. Merge with existing messages, deduplicating ONLY by unique message ID
    for (const msg of reconData) {
      const msgId = msg.id || msg._id;
      if (!clientMessagesMap.has(msgId)) {
        clientMessagesMap.set(msgId, msg);
      }
    }

    const reconciledList = Array.from(clientMessagesMap.values()).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    // Verify all 3 missed messages are present
    for (const missedId of missedIds) {
      assert.ok(clientMessagesMap.has(missedId), `Missed message ${missedId} must be recovered`);
    }

    // Verify no duplicates
    const allIds = reconciledList.map((m) => m.id || m._id);
    const uniqueIds = new Set(allIds);
    assert.strictEqual(allIds.length, uniqueIds.size, 'No duplicates may exist after reconciliation');

    // Verify correct chronological order
    for (let i = 1; i < reconciledList.length; i++) {
      const prevTime = new Date(reconciledList[i - 1].createdAt).getTime();
      const currTime = new Date(reconciledList[i].createdAt).getTime();
      assert.ok(currTime >= prevTime, `Messages must be sorted chronologically at index ${i}`);
    }

    // Verify the 3 missed messages appear in order
    const recoveredMissedTexts = reconciledList
      .map((m) => m.text)
      .filter((t) => missedTexts.includes(t));
    assert.deepStrictEqual(recoveredMissedTexts, missedTexts, 'Missed messages must maintain sequential order');
  });
});

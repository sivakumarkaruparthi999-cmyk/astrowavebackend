import test from 'node:test';
import assert from 'node:assert/strict';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { signAccessToken } from '../src/auth/jwt.js';
import { queryPostgres, queryPostgresSingle } from '../src/config/db.js';
import { inMemoryChatStore } from '../src/controllers/chat.controller.js';

const SERVER_URL = 'http://localhost:5001';

test('ASTROWAVE — Socket.IO Customer Leave Duplicate Message Bug Regression Suite', async (suite) => {
  const customerId = '44efc6e2-3ec2-453b-98f8-3fafdfb7f69f';
  const astrologerId = 'f7d44301-df84-477f-a4c2-e080768d378c';

  const customerToken = signAccessToken({ userId: customerId, role: 'customer' });
  const astrologerToken = signAccessToken({ userId: astrologerId, role: 'astrologer' });

  async function createTestConsultation(state: string = 'ACTIVE'): Promise<string> {
    const res = await queryPostgresSingle(
      `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute)
       VALUES ($1, $2, 'chat', $3, 20.0)
       RETURNING id`,
      [customerId, astrologerId, state]
    );
    return res.id;
  }

  async function cleanupConsultation(id: string) {
    inMemoryChatStore.delete(id);
    await queryPostgres('DELETE FROM consultations WHERE id = $1', [id]);
  }

  function createSocket(token: string, userId: string, role: string): ClientSocket {
    return Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token },
      query: { userId, role },
      forceNew: true,
      reconnection: false
    });
  }

  await suite.test('Scenario A: Customer manually leaves -> Exactly ONE authoritative leave broadcast', async () => {
    const cId = await createTestConsultation('ACTIVE');
    const astrologerSocket = createSocket(astrologerToken, astrologerId, 'astrologer');
    const customerSocket = createSocket(customerToken, customerId, 'customer');

    await Promise.all([
      new Promise<void>((r) => astrologerSocket.on('connect', () => r())),
      new Promise<void>((r) => customerSocket.on('connect', () => r()))
    ]);

    astrologerSocket.emit('join_consultation', { consultationId: cId });
    customerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    const receivedEvents: any[] = [];
    const eventNamesReceived: string[] = [];

    astrologerSocket.on('user_left_room', (data) => {
      receivedEvents.push({ ...data, _socketEvent: 'user_left_room' });
      eventNamesReceived.push('user_left_room');
    });
    astrologerSocket.on('participant_left', (data) => {
      receivedEvents.push({ ...data, _socketEvent: 'participant_left' });
      eventNamesReceived.push('participant_left');
    });
    astrologerSocket.on('chat_status', (data) => {
      receivedEvents.push({ ...data, _socketEvent: 'chat_status' });
      eventNamesReceived.push('chat_status');
    });

    // Customer manually leaves
    customerSocket.emit('leave_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 400));

    // Astrologer should receive exactly ONE event (user_left_room only)
    assert.equal(receivedEvents.length, 1, `Expected exactly 1 leave event, received ${receivedEvents.length}: ${JSON.stringify(receivedEvents)}`);
    assert.equal(eventNamesReceived[0], 'user_left_room', 'Must emit authoritative user_left_room event only');
    assert.equal(receivedEvents[0].id, `sys_leave_${cId}_${customerId}`, 'Leave event must carry deterministic ID');
    assert.match(receivedEvents[0].content, /Customer left the chat/i, 'Content must describe customer leaving');

    // Verify chat messages history API has exactly ONE system leave entry
    const historyRes = await fetch(`${SERVER_URL}/api/chat/messages/${cId}`, {
      headers: { Authorization: `Bearer ${astrologerToken}` }
    });
    const historyData = await historyRes.json();
    assert.equal(historyData.success, true);
    const leaveMsgs = historyData.data.filter((m: any) => m.id === `sys_leave_${cId}_${customerId}`);
    assert.equal(leaveMsgs.length, 1, 'Chat history must contain exactly 1 leave message');

    customerSocket.disconnect();
    astrologerSocket.disconnect();
    await cleanupConsultation(cId);
  });

  await suite.test('Scenario B: Customer socket disconnects directly -> Exactly ONE leave broadcast', async () => {
    const cId = await createTestConsultation('ACTIVE');
    const astrologerSocket = createSocket(astrologerToken, astrologerId, 'astrologer');
    const customerSocket = createSocket(customerToken, customerId, 'customer');

    await Promise.all([
      new Promise<void>((r) => astrologerSocket.on('connect', () => r())),
      new Promise<void>((r) => customerSocket.on('connect', () => r()))
    ]);

    astrologerSocket.emit('join_consultation', { consultationId: cId });
    customerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    const receivedEvents: any[] = [];
    astrologerSocket.on('user_left_room', (data) => {
      receivedEvents.push(data);
    });

    // Customer disconnects socket without calling leave_consultation
    customerSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(receivedEvents.length, 1, `Expected exactly 1 leave event on disconnect, got ${receivedEvents.length}`);
    assert.equal(receivedEvents[0].id, `sys_leave_${cId}_${customerId}`);

    astrologerSocket.disconnect();
    await cleanupConsultation(cId);
  });

  await suite.test('Scenario C: Customer leaves + disconnect event happens sequentially -> Exactly ONE event', async () => {
    const cId = await createTestConsultation('ACTIVE');
    const astrologerSocket = createSocket(astrologerToken, astrologerId, 'astrologer');
    const customerSocket = createSocket(customerToken, customerId, 'customer');

    await Promise.all([
      new Promise<void>((r) => astrologerSocket.on('connect', () => r())),
      new Promise<void>((r) => customerSocket.on('connect', () => r()))
    ]);

    astrologerSocket.emit('join_consultation', { consultationId: cId });
    customerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    const receivedEvents: any[] = [];
    astrologerSocket.on('user_left_room', (data) => {
      receivedEvents.push(data);
    });
    astrologerSocket.on('participant_left', (data) => {
      receivedEvents.push(data);
    });
    astrologerSocket.on('chat_status', (data) => {
      receivedEvents.push(data);
    });

    // Sequential leave_consultation immediately followed by socket disconnect
    customerSocket.emit('leave_consultation', { consultationId: cId });
    customerSocket.disconnect();
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(receivedEvents.length, 1, `Sequential leave+disconnect must produce exactly 1 event, got ${receivedEvents.length}`);
    assert.equal(receivedEvents[0].id, `sys_leave_${cId}_${customerId}`);

    astrologerSocket.disconnect();
    await cleanupConsultation(cId);
  });

  await suite.test('Scenario D: Customer reconnects after leaving active consultation -> Clean rejoin', async () => {
    const cId = await createTestConsultation('ACTIVE');
    const astrologerSocket = createSocket(astrologerToken, astrologerId, 'astrologer');
    let customerSocket = createSocket(customerToken, customerId, 'customer');

    await Promise.all([
      new Promise<void>((r) => astrologerSocket.on('connect', () => r())),
      new Promise<void>((r) => customerSocket.on('connect', () => r()))
    ]);

    astrologerSocket.emit('join_consultation', { consultationId: cId });
    customerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    const leaveEvents: any[] = [];
    astrologerSocket.on('user_left_room', (d) => leaveEvents.push(d));

    // Customer leaves
    customerSocket.emit('leave_consultation', { consultationId: cId });
    customerSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(leaveEvents.length, 1, 'First leave produces 1 event');

    // Customer reconnects to active consultation
    customerSocket = createSocket(customerToken, customerId, 'customer');
    await new Promise<void>((r) => customerSocket.on('connect', () => r()));
    customerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    // No stale leave events replayed
    assert.equal(leaveEvents.length, 1, 'Rejoining must not trigger additional leave events');

    customerSocket.disconnect();
    astrologerSocket.disconnect();
    await cleanupConsultation(cId);
  });

  await suite.test('Scenario E & F: Duplicate leave request & duplicate socket events are idempotent', async () => {
    const cId = await createTestConsultation('ACTIVE');
    const astrologerSocket = createSocket(astrologerToken, astrologerId, 'astrologer');
    const customerSocket = createSocket(customerToken, customerId, 'customer');

    await Promise.all([
      new Promise<void>((r) => astrologerSocket.on('connect', () => r())),
      new Promise<void>((r) => customerSocket.on('connect', () => r()))
    ]);

    astrologerSocket.emit('join_consultation', { consultationId: cId });
    customerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    const receivedEvents: any[] = [];
    astrologerSocket.on('user_left_room', (data) => {
      receivedEvents.push(data);
    });

    // Fire duplicate leave requests concurrently
    customerSocket.emit('leave_consultation', { consultationId: cId });
    customerSocket.emit('leave_consultation', { consultationId: cId });
    customerSocket.emit('leave_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(receivedEvents.length, 1, `Rapid duplicate leave requests must result in exactly 1 broadcast, got ${receivedEvents.length}`);

    // Client-side unique ID deduplication validation
    const seenEventIds = new Set<string>();
    let clientProcessedCount = 0;
    for (const evt of [...receivedEvents, ...receivedEvents]) {
      const eventId = evt.id || evt._id;
      if (eventId && !seenEventIds.has(eventId)) {
        seenEventIds.add(eventId);
        clientProcessedCount++;
      }
    }
    assert.equal(clientProcessedCount, 1, 'Client deduplicator must drop identical event IDs');

    customerSocket.disconnect();
    astrologerSocket.disconnect();
    await cleanupConsultation(cId);
  });

  await suite.test('Scenario G: Astrologer reconnects -> History has exactly 1 leave message', async () => {
    const cId = await createTestConsultation('ACTIVE');
    let astrologerSocket = createSocket(astrologerToken, astrologerId, 'astrologer');
    const customerSocket = createSocket(customerToken, customerId, 'customer');

    await Promise.all([
      new Promise<void>((r) => astrologerSocket.on('connect', () => r())),
      new Promise<void>((r) => customerSocket.on('connect', () => r()))
    ]);

    astrologerSocket.emit('join_consultation', { consultationId: cId });
    customerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    // Customer leaves
    customerSocket.emit('leave_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 300));
    customerSocket.disconnect();

    // Astrologer reconnects
    astrologerSocket.disconnect();
    astrologerSocket = createSocket(astrologerToken, astrologerId, 'astrologer');
    await new Promise<void>((r) => astrologerSocket.on('connect', () => r()));
    astrologerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    // Verify stored history via HTTP endpoint
    const historyRes = await fetch(`${SERVER_URL}/api/chat/messages/${cId}`, {
      headers: { Authorization: `Bearer ${astrologerToken}` }
    });
    const historyData = await historyRes.json();
    assert.equal(historyData.success, true);
    const leaveMsgs = historyData.data.filter((m: any) => m.id === `sys_leave_${cId}_${customerId}`);
    assert.equal(leaveMsgs.length, 1, `History must contain exactly 1 leave message, got ${leaveMsgs.length}`);

    astrologerSocket.disconnect();
    await cleanupConsultation(cId);
  });

  await suite.test('Scenario H: Consultation already ended -> No additional leave message is emitted', async () => {
    // Create consultation already in ENDED state
    const cId = await createTestConsultation('ENDED');
    const astrologerSocket = createSocket(astrologerToken, astrologerId, 'astrologer');
    const customerSocket = createSocket(customerToken, customerId, 'customer');

    await Promise.all([
      new Promise<void>((r) => astrologerSocket.on('connect', () => r())),
      new Promise<void>((r) => customerSocket.on('connect', () => r()))
    ]);

    astrologerSocket.emit('join_consultation', { consultationId: cId });
    customerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    const receivedEvents: any[] = [];
    astrologerSocket.on('user_left_room', (data) => receivedEvents.push(data));

    // Customer leaves consultation that is already ENDED
    customerSocket.emit('leave_consultation', { consultationId: cId });
    customerSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(receivedEvents.length, 0, `No leave event must be emitted for already ENDED consultation, got ${receivedEvents.length}`);

    astrologerSocket.disconnect();
    await cleanupConsultation(cId);
  });

  await suite.test('Verification: Normal chat messages still appear exactly ONCE without duplicate or drop', async () => {
    const cId = await createTestConsultation('ACTIVE');
    const astrologerSocket = createSocket(astrologerToken, astrologerId, 'astrologer');
    const customerSocket = createSocket(customerToken, customerId, 'customer');

    await Promise.all([
      new Promise<void>((r) => astrologerSocket.on('connect', () => r())),
      new Promise<void>((r) => customerSocket.on('connect', () => r()))
    ]);

    astrologerSocket.emit('join_consultation', { consultationId: cId });
    customerSocket.emit('join_consultation', { consultationId: cId });
    await new Promise((r) => setTimeout(r, 200));

    const receivedMessages: any[] = [];
    astrologerSocket.on('new_message', (msg) => {
      if (msg.consultationId === cId) {
        receivedMessages.push(msg);
      }
    });

    const sendRes = await new Promise<any>((resolve) => {
      customerSocket.emit('send_message', {
        id: 'msg-norm-001',
        consultationId: cId,
        recipientId: astrologerId,
        senderId: customerId,
        content: 'Namaste! Normal message test',
        messageType: 'text'
      }, (res: any) => resolve(res));
    });

    assert.equal(sendRes.success, true);
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(receivedMessages.length, 1, `Normal chat message must be delivered exactly once, got ${receivedMessages.length}`);
    assert.equal(receivedMessages[0].content, 'Namaste! Normal message test');
    assert.equal(receivedMessages[0].id, 'msg-norm-001');

    customerSocket.disconnect();
    astrologerSocket.disconnect();
    await cleanupConsultation(cId);
  });

  // Force clean exit when suite completes
  setTimeout(() => process.exit(0), 500);
});

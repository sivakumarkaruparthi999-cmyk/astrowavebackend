import test from 'node:test';
import assert from 'node:assert/strict';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { signAccessToken } from '../src/auth/jwt.js';
import { queryPostgres, queryPostgresSingle } from '../src/config/db.js';
import jwt from 'jsonwebtoken';

const SERVER_URL = 'http://localhost:5001';

test('Realtime Chat Delivery Architecture Verification', async (t) => {
  const customerId = '44efc6e2-3ec2-453b-98f8-3fafdfb7f69f';
  const astrologerId = 'f7d44301-df84-477f-a4c2-e080768d378c'; // javed sayed

  // Generate valid tokens
  const customerToken = signAccessToken({ userId: customerId, role: 'customer' });
  const astrologerToken = signAccessToken({ userId: astrologerId, role: 'astrologer' });

  // 1. Create an active test consultation
  const consultation = await queryPostgresSingle(
    `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute)
     VALUES ($1, $2, 'chat', 'ACCEPTED', 20.0)
     RETURNING *`,
    [customerId, astrologerId]
  );
  assert.ok(consultation?.id, 'Consultation must be created');
  const consultationId = consultation.id;

  await t.test('Test 1: Authenticated Socket connection and Customer -> Astrologer message delivery', async () => {
    // Connect Customer Socket
    const customerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: customerToken },
      query: { userId: customerId, role: 'customer' }
    });

    // Connect Astrologer Socket
    const astrologerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: astrologerToken },
      query: { userId: astrologerId, role: 'astrologer' }
    });

    await Promise.all([
      new Promise<void>((resolve) => customerSocket.on('connect', () => resolve())),
      new Promise<void>((resolve) => astrologerSocket.on('connect', () => resolve()))
    ]);

    // Join consultation rooms
    customerSocket.emit('join_consultation', { consultationId });
    astrologerSocket.emit('join_consultation', { consultationId });
    await new Promise((r) => setTimeout(r, 200));

    // Astrologer listens for incoming message
    const incomingPromise = new Promise<any>((resolve) => {
      astrologerSocket.on('new_message', (msg) => {
        if (msg.consultationId === consultationId) {
          resolve(msg);
        }
      });
    });

    // Customer sends message with ACK
    const ackPromise = new Promise<any>((resolve) => {
      customerSocket.emit('send_message', {
        id: 'msg-test-001',
        consultationId,
        recipientId: astrologerId,
        senderId: customerId,
        content: 'Namaste Pandit Ji 🙏',
        messageType: 'text'
      }, (response: any) => {
        resolve(response);
      });
    });

    const [ackRes, receivedMsg] = await Promise.all([ackPromise, incomingPromise]);

    assert.equal(ackRes.success, true, 'Backend must acknowledge message send successfully');
    assert.equal(receivedMsg.content, 'Namaste Pandit Ji 🙏', 'Astrologer must receive exact message content');
    assert.equal(receivedMsg.senderId, customerId, 'SenderId must match customer');
    assert.equal(receivedMsg.consultationId, consultationId, 'ConsultationId must match active consultation');

    customerSocket.disconnect();
    astrologerSocket.disconnect();
  });

  await t.test('Test 2: Astrologer -> Customer reply message delivery', async () => {
    const customerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: customerToken },
      query: { userId: customerId, role: 'customer' }
    });

    const astrologerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: astrologerToken },
      query: { userId: astrologerId, role: 'astrologer' }
    });

    await Promise.all([
      new Promise<void>((resolve) => customerSocket.on('connect', () => resolve())),
      new Promise<void>((resolve) => astrologerSocket.on('connect', () => resolve()))
    ]);

    customerSocket.emit('join_consultation', { consultationId });
    astrologerSocket.emit('join_consultation', { consultationId });
    await new Promise((r) => setTimeout(r, 200));

    const customerReceivePromise = new Promise<any>((resolve) => {
      customerSocket.on('new_message', (msg) => {
        if (msg.consultationId === consultationId) {
          resolve(msg);
        }
      });
    });

    const replyAck = await new Promise<any>((resolve) => {
      astrologerSocket.emit('send_message', {
        id: 'msg-test-002',
        consultationId,
        recipientId: customerId,
        senderId: astrologerId,
        content: 'Namaste! How can I help you today?',
        messageType: 'text'
      }, (res: any) => resolve(res));
    });

    const customerReceived = await customerReceivePromise;

    assert.equal(replyAck.success, true, 'Astrologer send must succeed');
    assert.equal(customerReceived.content, 'Namaste! How can I help you today?');
    assert.equal(customerReceived.senderId, astrologerId);

    customerSocket.disconnect();
    astrologerSocket.disconnect();
  });

  await t.test('Test 3: Rapid 5 messages FIFO order without duplicates', async () => {
    const customerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: customerToken }
    });

    const astrologerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: astrologerToken }
    });

    await Promise.all([
      new Promise<void>((r) => customerSocket.on('connect', () => r())),
      new Promise<void>((r) => astrologerSocket.on('connect', () => r()))
    ]);

    customerSocket.emit('join_consultation', { consultationId });
    astrologerSocket.emit('join_consultation', { consultationId });
    await new Promise((r) => setTimeout(r, 200));

    const received: string[] = [];
    astrologerSocket.on('new_message', (msg) => {
      if (msg.consultationId === consultationId && msg.content.startsWith('RAPID_')) {
        received.push(msg.content);
      }
    });

    const acks = await Promise.all([1, 2, 3, 4, 5].map((i) => {
      return new Promise<any>((resolve) => {
        customerSocket.emit('send_message', {
          id: `rapid-msg-${i}-${Date.now()}`,
          consultationId,
          recipientId: astrologerId,
          content: `RAPID_${i}`,
          messageType: 'text'
        }, (res: any) => resolve(res));
      });
    }));

    // Wait for all messages to be delivered
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(acks.every((a) => a.success === true), true, 'All 5 rapid sends must succeed');
    assert.deepEqual(received, ['RAPID_1', 'RAPID_2', 'RAPID_3', 'RAPID_4', 'RAPID_5'], 'Messages must arrive in exact sequential order');

    customerSocket.disconnect();
    astrologerSocket.disconnect();
  });

  await t.test('Test 4: Expired token handshake rejection', async () => {
    // Generate an expired JWT (expired 1 hour ago)
    const secret = process.env.JWT_ACCESS_SECRET || 'astrotalk-jwt-secret-key-production-change-this-in-env';
    const expiredToken = jwt.sign(
      { userId: customerId, role: 'customer' },
      secret,
      { expiresIn: '-1h' }
    );

    const expiredSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: expiredToken }
    });

    const errorResult = await new Promise<any>((resolve) => {
      expiredSocket.on('connect_error', (err) => {
        resolve(err);
      });
      expiredSocket.on('connect', () => {
        resolve('CONNECTED_UNEXPECTEDLY');
      });
    });

    assert.notEqual(errorResult, 'CONNECTED_UNEXPECTEDLY', 'Expired token must NOT be allowed to connect');
    assert.ok(errorResult.message.includes('Authentication failed'), 'Error message must specify authentication failure');
    expiredSocket.disconnect();
  });

  await t.test('Test 5: Attempt to send using an ended consultation is rejected', async () => {
    // Create an ENDED consultation
    const endedConsultation = await queryPostgresSingle(
      `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute)
       VALUES ($1, $2, 'chat', 'ENDED', 20.0)
       RETURNING id`,
      [customerId, astrologerId]
    );

    const customerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: customerToken }
    });

    await new Promise<void>((r) => customerSocket.on('connect', () => r()));

    const ackRes = await new Promise<any>((resolve) => {
      customerSocket.emit('send_message', {
        id: 'msg-ended-test',
        consultationId: endedConsultation.id,
        recipientId: astrologerId,
        content: 'This should fail',
        messageType: 'text'
      }, (res: any) => resolve(res));
    });

    assert.equal(ackRes.success, false, 'Send on ended consultation must fail');
    assert.ok(ackRes.error.includes('ended'), 'Error must report consultation is ended');

    customerSocket.disconnect();
  });

  await t.test('Test 6: Wrong recipient ID is rejected', async () => {
    const wrongRecipientId = '00000000-0000-0000-0000-000000000099';

    const customerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: customerToken }
    });

    await new Promise<void>((r) => customerSocket.on('connect', () => r()));

    const ackRes = await new Promise<any>((resolve) => {
      customerSocket.emit('send_message', {
        id: 'msg-wrong-recipient',
        consultationId: consultationId,
        recipientId: wrongRecipientId,
        content: 'Should be rejected',
        messageType: 'text'
      }, (res: any) => resolve(res));
    });

    assert.equal(ackRes.success, false, 'Send with wrong recipient ID must fail');
    assert.ok(ackRes.error.includes('Recipient does not belong'), 'Error must report recipient mismatch');

    customerSocket.disconnect();
  });

  await t.test('Test 7: Reconnect Astrologer and verify message delivery', async () => {
    const customerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: customerToken }
    });

    let astrologerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: astrologerToken }
    });

    await Promise.all([
      new Promise<void>((r) => customerSocket.on('connect', () => r())),
      new Promise<void>((r) => astrologerSocket.on('connect', () => r()))
    ]);

    // Simulate astrologer disconnect
    astrologerSocket.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Astrologer reconnects
    astrologerSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: astrologerToken }
    });
    await new Promise<void>((r) => astrologerSocket.on('connect', () => r()));

    astrologerSocket.emit('join_consultation', { consultationId });
    customerSocket.emit('join_consultation', { consultationId });
    await new Promise((r) => setTimeout(r, 100));

    const receivePromise = new Promise<any>((resolve) => {
      astrologerSocket.on('new_message', (msg) => {
        if (msg.consultationId === consultationId) resolve(msg);
      });
    });

    await new Promise<any>((resolve) => {
      customerSocket.emit('send_message', {
        id: 'msg-reconnect-test',
        consultationId,
        recipientId: astrologerId,
        content: 'Post-reconnect message',
        messageType: 'text'
      }, (res: any) => resolve(res));
    });

    const received = await receivePromise;
    assert.equal(received.content, 'Post-reconnect message', 'Message must arrive after astrologer reconnect');

    customerSocket.disconnect();
    astrologerSocket.disconnect();
  });

  await t.test('Test 8: Background notification broadcast to user_${astrologerId}', async () => {
    // When the astrologer app is in background or on a different screen,
    // it is still in its personal room user_${astrologerId}.
    // Verify that send_message broadcasts to user_${recipientId} so global alert/notification triggers.
    const astrologerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: astrologerToken }
    });

    const customerSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: customerToken }
    });

    await Promise.all([
      new Promise<void>((r) => customerSocket.on('connect', () => r())),
      new Promise<void>((r) => astrologerSocket.on('connect', () => r()))
    ]);

    // Astrologer has NOT joined consultation room yet (simulating background or main screen)
    const personalRoomPromise = new Promise<any>((resolve) => {
      astrologerSocket.on('new_message', (msg) => {
        resolve(msg);
      });
    });

    const sendRes = await new Promise<any>((resolve) => {
      customerSocket.emit('send_message', {
        id: 'msg-background-test',
        consultationId,
        recipientId: astrologerId,
        content: 'Background alert test',
        messageType: 'text'
      }, (res: any) => resolve(res));
    });

    assert.equal(sendRes.success, true);
    const bgMsg = await personalRoomPromise;
    assert.equal(bgMsg.content, 'Background alert test', 'Astrologer personal room must receive message even outside consultation room');

    customerSocket.disconnect();
    astrologerSocket.disconnect();
  });

  // Clean up test consultation
  await queryPostgres('DELETE FROM consultations WHERE id = $1', [consultationId]);
});

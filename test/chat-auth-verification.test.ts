import test from 'node:test';
import assert from 'node:assert/strict';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { signAccessToken } from '../src/auth/jwt.js';
import { queryPostgres, queryPostgresSingle } from '../src/config/db.js';

const SERVER_URL = 'http://localhost:5001';

test('Comprehensive Chat Participant Authorization & Delivery Verification (Tests 1-11)', async (t) => {
  const customerId = '44efc6e2-3ec2-453b-98f8-3fafdfb7f69f'; // Rahul Sharma (customer@astrowave.com)
  const astrologerId = 'f7d44301-df84-477f-a4c2-e080768d378c'; // javed sayed (astrologer)
  const foreignCustomerId = '24e8d283-b3a6-4910-81bb-3662a83762c4';
  const foreignAstrologerId = '58232efa-3902-4f53-bdcf-7a1685097758';

  const customerToken = signAccessToken({ userId: customerId, role: 'customer' });
  const astrologerToken = signAccessToken({ userId: astrologerId, role: 'astrologer' });
  const foreignCustomerToken = signAccessToken({ userId: foreignCustomerId, role: 'customer' });

  // Connect sockets
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

  let consultationId1 = '';
  let consultationId2 = '';

  // TEST 1: Customer starts new chat. Expected: consultation created.
  await t.test('TEST 1: Customer starts new chat -> consultation created', async () => {
    const res = await queryPostgresSingle(
      `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute)
       VALUES ($1, $2, 'chat', 'ACTIVE', 25.0)
       RETURNING *`,
      [customerId, astrologerId]
    );
    assert.ok(res?.id, 'Consultation must be created');
    assert.equal(res.user_id, customerId);
    assert.equal(res.astrologer_id, astrologerId);
    assert.equal(res.state, 'ACTIVE');
    consultationId1 = res.id;

    customerSocket.emit('join_consultation', { consultationId: consultationId1 });
    astrologerSocket.emit('join_consultation', { consultationId: consultationId1 });
    await new Promise((r) => setTimeout(r, 200));
  });

  // TEST 2: Customer sends message. Expected: astrologer receives it.
  await t.test('TEST 2: Customer sends message -> astrologer receives it', async () => {
    const msgPromise = new Promise<any>((resolve) => {
      astrologerSocket.once('new_message', (msg) => resolve(msg));
    });

    const sendAck = await new Promise<any>((resolve) => {
      customerSocket.emit(
        'send_message',
        {
          consultationId: consultationId1,
          recipientId: astrologerId,
          content: 'Hello Astrologer from Customer',
          messageType: 'text'
        },
        (ack: any) => resolve(ack)
      );
    });

    assert.equal(sendAck.success, true, 'Customer message send must succeed');
    const received = await msgPromise;
    assert.equal(received.content, 'Hello Astrologer from Customer');
    assert.equal(received.consultationId, consultationId1);
    assert.equal(received.senderId, customerId);
    assert.equal(received.recipientId, astrologerId);
  });

  // TEST 3: Astrologer sends message. Expected: customer receives it.
  await t.test('TEST 3: Astrologer sends message -> customer receives it', async () => {
    const msgPromise = new Promise<any>((resolve) => {
      customerSocket.once('new_message', (msg) => resolve(msg));
    });

    const sendAck = await new Promise<any>((resolve) => {
      astrologerSocket.emit(
        'send_message',
        {
          consultationId: consultationId1,
          recipientId: customerId,
          content: 'Hello Customer from Astrologer',
          messageType: 'text'
        },
        (ack: any) => resolve(ack)
      );
    });

    assert.equal(sendAck.success, true, 'Astrologer message send must succeed');
    const received = await msgPromise;
    assert.equal(received.content, 'Hello Customer from Astrologer');
    assert.equal(received.consultationId, consultationId1);
    assert.equal(received.senderId, astrologerId);
    assert.equal(received.recipientId, customerId);
  });

  // TEST 4: Multiple messages in both directions. Expected: all succeed.
  await t.test('TEST 4: Multiple bidirectional messages succeed', async () => {
    for (let i = 1; i <= 3; i++) {
      const ack1: any = await new Promise((res) => {
        customerSocket.emit('send_message', {
          consultationId: consultationId1,
          recipientId: astrologerId,
          content: `Customer round ${i}`
        }, (ack: any) => res(ack));
      });
      assert.equal(ack1.success, true);

      const ack2: any = await new Promise((res) => {
        astrologerSocket.emit('send_message', {
          consultationId: consultationId1,
          recipientId: customerId,
          content: `Astrologer round ${i}`
        }, (ack: any) => res(ack));
      });
      assert.equal(ack2.success, true);
    }
  });

  // TEST 5: Customer sends 10 rapid messages. Expected: all valid messages persist.
  await t.test('TEST 5: Customer sends 10 rapid messages -> all persist', async () => {
    const promises = [];
    for (let i = 1; i <= 10; i++) {
      promises.push(new Promise<any>((res) => {
        customerSocket.emit('send_message', {
          consultationId: consultationId1,
          recipientId: astrologerId,
          content: `Rapid customer message ${i}`
        }, (ack: any) => res(ack));
      }));
    }
    const acks = await Promise.all(promises);
    assert.equal(acks.every((a) => a.success === true), true, 'All 10 rapid customer messages must succeed');
  });

  // TEST 6: Astrologer sends 10 rapid messages. Expected: all valid messages persist.
  await t.test('TEST 6: Astrologer sends 10 rapid messages -> all persist', async () => {
    const promises = [];
    for (let i = 1; i <= 10; i++) {
      promises.push(new Promise<any>((res) => {
        astrologerSocket.emit('send_message', {
          consultationId: consultationId1,
          recipientId: customerId,
          content: `Rapid astrologer message ${i}`
        }, (ack: any) => res(ack));
      }));
    }
    const acks = await Promise.all(promises);
    assert.equal(acks.every((a) => a.success === true), true, 'All 10 rapid astrologer messages must succeed');
  });

  // End consultation 1
  await queryPostgres(`UPDATE consultations SET state = 'ENDED', end_time = NOW() WHERE id = $1`, [consultationId1]);

  // TEST 7: Customer starts second consultation with SAME astrologer.
  // Expected: NEW consultation ID. Old messages NOT displayed.
  await t.test('TEST 7: Customer starts second consultation with SAME astrologer -> NEW consultation ID, isolated history', async () => {
    const res = await queryPostgresSingle(
      `INSERT INTO consultations (user_id, astrologer_id, type, state, rate_per_minute)
       VALUES ($1, $2, 'chat', 'ACTIVE', 25.0)
       RETURNING *`,
      [customerId, astrologerId]
    );
    assert.ok(res?.id);
    consultationId2 = res.id;
    assert.notEqual(consultationId1, consultationId2, 'Must be a brand new consultation ID');

    customerSocket.emit('join_consultation', { consultationId: consultationId2 });
    astrologerSocket.emit('join_consultation', { consultationId: consultationId2 });
    await new Promise((r) => setTimeout(r, 200));

    // Verify history of consultation 2 does not contain messages from consultation 1
    const fetchRes = await fetch(`${SERVER_URL}/api/chat/messages/${consultationId2}`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const historyJson = await fetchRes.json();
    assert.equal(historyJson.success, true);
    // Only join messages or 0 messages should be in consultationId2 history
    const oldMsgFound = (historyJson.data || []).some((m: any) => m.content?.includes('Rapid customer message'));
    assert.equal(oldMsgFound, false, 'Old messages from consultation 1 must NOT appear in consultation 2');
  });

  // TEST 8: Astrologer sends message in second consultation. Expected: PASS.
  await t.test('TEST 8: Astrologer sends message in second consultation -> PASS', async () => {
    const msgPromise = new Promise<any>((resolve) => {
      customerSocket.once('new_message', (msg) => resolve(msg));
    });

    const sendAck: any = await new Promise((res) => {
      astrologerSocket.emit('send_message', {
        consultationId: consultationId2,
        recipientId: customerId,
        content: 'Welcome to consultation 2!'
      }, (ack: any) => res(ack));
    });

    assert.equal(sendAck.success, true);
    const received = await msgPromise;
    assert.equal(received.content, 'Welcome to consultation 2!');
    assert.equal(received.consultationId, consultationId2);
  });

  // TEST 9: Attempt to send a message using an old consultation ID after it has ended. Expected: REJECTED.
  await t.test('TEST 9: Send message to ended consultation 1 -> REJECTED', async () => {
    const sendAck: any = await new Promise((res) => {
      customerSocket.emit('send_message', {
        consultationId: consultationId1,
        recipientId: astrologerId,
        content: 'Late message to ended session'
      }, (ack: any) => res(ack));
    });

    assert.equal(sendAck.success, false, 'Message to ended consultation must be rejected');
    assert.match(sendAck.error, /ended/i);
  });

  // TEST 10: Attempt to use another customer's ID (Foreign user tries to send or foreign recipient). Expected: REJECTED.
  await t.test('TEST 10: Attempt to send with foreign recipient -> REJECTED', async () => {
    const sendAck: any = await new Promise((res) => {
      astrologerSocket.emit('send_message', {
        consultationId: consultationId2,
        recipientId: foreignCustomerId, // Wrong recipient not belonging to this consultation
        content: 'Hacked message'
      }, (ack: any) => res(ack));
    });

    assert.equal(sendAck.success, false, 'Message with foreign recipient must be rejected');
    assert.match(sendAck.error, /Recipient does not belong/i);
  });

  // TEST 11: Attempt to use another astrologer's ID (Sender mismatch or foreign astrologer). Expected: REJECTED.
  await t.test('TEST 11: Foreign user attempting to participate in consultation 2 -> REJECTED', async () => {
    const foreignSocket: ClientSocket = Client(SERVER_URL, {
      transports: ['websocket'],
      auth: { token: foreignCustomerToken },
      query: { userId: foreignCustomerId, role: 'customer' }
    });
    await new Promise<void>((resolve) => foreignSocket.on('connect', () => resolve()));

    const sendAck: any = await new Promise((res) => {
      foreignSocket.emit('send_message', {
        consultationId: consultationId2,
        recipientId: astrologerId,
        content: 'Intruder message'
      }, (ack: any) => res(ack));
    });

    foreignSocket.disconnect();
    assert.equal(sendAck.success, false, 'Foreign user message must be rejected');
    assert.match(sendAck.error, /Not a participant/i);
  });

  // Cleanup
  customerSocket.disconnect();
  astrologerSocket.disconnect();
  await queryPostgres(`UPDATE consultations SET state = 'ENDED', end_time = NOW() WHERE id = $1`, [consultationId2]);
});

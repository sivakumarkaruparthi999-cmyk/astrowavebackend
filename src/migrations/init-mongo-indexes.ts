import { connectMongo } from '../config/db.js';
import { ChatMessage } from '../models/mongo/ChatMessage.js';
import { ChatConversation } from '../models/mongo/ChatConversation.js';
import { CallSession } from '../models/mongo/CallSession.js';
import { VideoCallSession } from '../models/mongo/VideoCallSession.js';
import { RealtimeSession } from '../models/mongo/RealtimeSession.js';
import { NotificationLog } from '../models/mongo/NotificationLog.js';

export async function initMongoIndexes(): Promise<void> {
  console.log('[MongoDB] Initializing and verifying document collection indexes...');
  const conn = await connectMongo();
  if (!conn) {
    console.warn('[MongoDB] MongoDB not available. Skipping index creation.');
    return;
  }

  try {
    await Promise.all([
      ChatMessage.createIndexes(),
      ChatConversation.createIndexes(),
      CallSession.createIndexes(),
      VideoCallSession.createIndexes(),
      RealtimeSession.createIndexes(),
      NotificationLog.createIndexes(),
    ]);
    console.log('[MongoDB] All document collection indexes synchronized successfully:');
    console.log('  - chat_messages: consultationId, senderId, recipientId, createdAt, messageId');
    console.log('  - chat_conversations: participants.userId, updatedAt');
    console.log('  - call_sessions: consultationId, userId, astrologerId, createdAt');
    console.log('  - video_call_sessions: consultationId, sessionId');
    console.log('  - realtime_sessions: consultationId, userId, astrologerId');
    console.log('  - notification_logs: userId, createdAt');
  } catch (error) {
    console.error('[MongoDB] Error creating indexes:', error);
    throw error;
  }
}

// Execute standalone if executed via CLI
if (process.argv[1]?.endsWith('init-mongo-indexes.ts') || process.argv[1]?.endsWith('init-mongo-indexes.js')) {
  initMongoIndexes()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

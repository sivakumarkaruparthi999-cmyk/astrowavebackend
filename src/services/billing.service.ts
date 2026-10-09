import { queryPostgres, queryPostgresSingle } from '../config/db.js';
import { CallSession } from '../models/mongo/CallSession.js';
import { getSocketServer } from '../websocket/socket.server.js';
import { Server as SocketIOServer } from 'socket.io';
import mongoose from 'mongoose';

export interface BillingResult {
  billingId: string;
  consultationId: string;
  billedDurationSeconds: number;
  billedMinutes: number;
  grossAmount: number;
  platformFee: number;
  astrologerEarnings: number;
  currency: string;
  status: string;
}

export class BillingService {
  private static schedulerInterval: NodeJS.Timeout | null = null;
  private static isTickProcessing: boolean = false;

  /**
   * Start server-side periodic continuous billing scheduler (ticks every 5 seconds)
   */
  static startBillingScheduler(io?: SocketIOServer): void {
    if (this.schedulerInterval) {
      return;
    }

    console.log('[BILLING] Starting authoritative continuous billing engine (5s interval)');
    this.schedulerInterval = setInterval(async () => {
      if (this.isTickProcessing) return;
      this.isTickProcessing = true;

      try {
        const activeConsultations = await queryPostgres(
          `SELECT id, user_id, astrologer_id, rate_per_minute, start_time, astrologer_joined_at, last_billed_minute, total_amount, type
           FROM consultations
           WHERE state = 'ACTIVE' AND astrologer_joined_at IS NOT NULL`
        );

        if (!activeConsultations || activeConsultations.length === 0) {
          this.isTickProcessing = false;
          return;
        }

        const effectiveIo = io || getSocketServer();

        for (const cons of activeConsultations) {
          try {
            const tickResult = await queryPostgresSingle(
              'SELECT * FROM bill_consultation_minute_tick_atomic($1, 20.00)',
              [cons.id]
            );

            if (!tickResult) continue;

            const {
              status,
              consultation_id,
              user_id,
              astrologer_id,
              elapsed_seconds,
              billed_minute,
              incremental_charge,
              total_charged,
              wallet_balance,
            } = tickResult;

            if (status === 'SUCCESS' && Number(incremental_charge) > 0) {
              console.log(
                `[BILLING] Minute tick charged: consultationId=${consultation_id}, billedMinute=${billed_minute}, incremental=₹${incremental_charge}, totalCharged=₹${total_charged}, newWallet=₹${wallet_balance}`
              );

              if (effectiveIo) {
                // Broadcast authoritative wallet balance to customer
                effectiveIo.to(`user_${user_id}`).emit('wallet_updated', {
                  balance: Number(wallet_balance),
                  currency: 'INR',
                });

                // Broadcast tick event to both participants
                const tickPayload = {
                  consultationId: consultation_id,
                  elapsedSeconds: Number(elapsed_seconds),
                  billedMinute: Number(billed_minute),
                  incrementalCharge: Number(incremental_charge),
                  totalCharged: Number(total_charged),
                  remainingBalance: Number(wallet_balance),
                  currency: 'INR',
                };
                effectiveIo.to(`consultation_${consultation_id}`).emit('consultation_tick', tickPayload);
                effectiveIo.to(`user_${user_id}`).emit('consultation_tick', tickPayload);
                effectiveIo.to(`user_${astrologer_id}`).emit('consultation_tick', tickPayload);
              }
            } else if (status === 'INSUFFICIENT_BALANCE') {
              console.warn(
                `[BILLING] Insufficient balance for consultation ${consultation_id}. Wallet: ₹${wallet_balance}, Needed: ₹${incremental_charge}. Terminating session.`
              );

              if (effectiveIo) {
                const lowBalPayload = {
                  consultationId: consultation_id,
                  message: 'Consultation ended due to insufficient wallet balance.',
                  balance: Number(wallet_balance),
                };
                effectiveIo.to(`consultation_${consultation_id}`).emit('insufficient_balance', lowBalPayload);
                effectiveIo.to(`user_${user_id}`).emit('insufficient_balance', lowBalPayload);
                effectiveIo.to(`user_${astrologer_id}`).emit('insufficient_balance', lowBalPayload);

                const endPayload = {
                  consultationId: consultation_id,
                  reason: 'insufficient_balance',
                  endedBy: 'system',
                  timestamp: new Date().toISOString(),
                };
                effectiveIo.to(`consultation_${consultation_id}`).emit('call_end', endPayload);
                effectiveIo.to(`consultation_${consultation_id}`).emit('call_ended', endPayload);
              }

              // Auto-settle remaining usage
              await this.endAndBillConsultation({
                consultationId: consultation_id,
                callerUserId: user_id,
                durationSeconds: Number(elapsed_seconds),
              }).catch((e) => console.error('[BILLING] Error auto-settling low balance call:', e));
            }
          } catch (itemErr) {
            console.error(`[BILLING] Error executing tick for consultation ${cons.id}:`, itemErr);
          }
        }
      } catch (loopErr) {
        console.error('[BILLING] Error in billing scheduler loop:', loopErr);
      } finally {
        this.isTickProcessing = false;
      }
    }, 5000);
  }

  /**
   * Stop billing scheduler
   */
  static stopBillingScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
      console.log('[BILLING] Authoritative continuous billing engine stopped');
    }
  }

  /**
   * End and bill consultation atomically (Final Reconciliation)
   */
  static async endAndBillConsultation(params: {
    consultationId: string;
    callerUserId: string;
    callerRole?: string;
    durationSeconds?: number;
    idempotencyKey?: string;
  }): Promise<BillingResult> {
    const { consultationId, callerUserId, callerRole, durationSeconds, idempotencyKey } = params;

    const consultation = await queryPostgresSingle('SELECT * FROM consultations WHERE id = $1', [consultationId]);
    if (!consultation) {
      throw new Error(`Consultation ${consultationId} not found`);
    }

    // Ownership check: Caller must be the assigned customer, assigned astrologer, or admin
    if (!callerUserId) {
      throw new Error('Unauthorized: Authentication required to end or bill consultation');
    }
    const isCustomer = consultation.user_id === callerUserId;
    const isAstrologer = consultation.astrologer_id === callerUserId;
    const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';

    if (!isCustomer && !isAstrologer && !isAdmin) {
      throw new Error('Unauthorized: You are not authorized to end or bill this consultation');
    }

    // If consultation already ended and billed, return existing billing
    if (consultation.state === 'ENDED') {
      const existingBilling = await queryPostgresSingle(
        'SELECT * FROM consultation_billing WHERE consultation_id = $1',
        [consultationId]
      );
      if (existingBilling) {
        return {
          billingId: existingBilling.id,
          consultationId,
          billedDurationSeconds: existingBilling.billed_duration_seconds,
          billedMinutes: existingBilling.billed_minutes,
          grossAmount: Number(existingBilling.gross_amount),
          platformFee: Number(existingBilling.platform_fee),
          astrologerEarnings: Number(existingBilling.astrologer_earnings),
          currency: existingBilling.currency || 'INR',
          status: existingBilling.status,
        };
      }
    }

    // Reconcile duration safely
    let isConnectedCall = false;
    let reconciledSeconds = 0;

    // 1. Check MongoDB session if available
    try {
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        const callSession = await CallSession.findOne({ consultationId }).sort({ createdAt: -1 });
        if (callSession) {
          if (callSession.connectedAt || callSession.status === 'connected' || callSession.durationSeconds > 0) {
            isConnectedCall = true;
            reconciledSeconds = callSession.durationSeconds;
          }
        }
      }
    } catch (e) {
      // MongoDB lookup error shouldn't block billing
    }

    // 2. Check PostgreSQL astrologer_joined_at (strictly when astrologer joined)
    if (consultation.astrologer_joined_at) {
      isConnectedCall = true;
      const wallClockSeconds = Math.max(0, Math.floor((Date.now() - new Date(consultation.astrologer_joined_at).getTime()) / 1000));
      reconciledSeconds = Math.max(reconciledSeconds, wallClockSeconds);
    } else {
      // Astrologer NEVER joined the consultation: amount should NOT be deducted
      isConnectedCall = false;
      reconciledSeconds = 0;
    }

    // 3. Check client-reported duration only if astrologer actually joined
    if (consultation.astrologer_joined_at && durationSeconds !== undefined && durationSeconds > 0) {
      isConnectedCall = true;
      reconciledSeconds = Math.max(reconciledSeconds, durationSeconds);
    } else if (durationSeconds === 0 || !consultation.astrologer_joined_at) {
      // Explicit 0 duration or astrologer never joined
      if (!consultation.astrologer_joined_at) {
        reconciledSeconds = 0;
        isConnectedCall = false;
      }
    } else if (!isConnectedCall && consultation.type === 'chat' && consultation.astrologer_joined_at) {
      // Completed chat with astrologer joined
      reconciledSeconds = 60;
      isConnectedCall = true;
    }

    // Cap reported duration strictly against actual elapsed wall-clock time since astrologer joined
    const startTime = consultation.astrologer_joined_at ? new Date(consultation.astrologer_joined_at).getTime() : Date.now();
    const actualElapsedSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000) + 60); // 60s grace buffer
    const maxPossibleSeconds = Math.min(7200, actualElapsedSeconds);
    if (reconciledSeconds > maxPossibleSeconds) {
      reconciledSeconds = maxPossibleSeconds;
    }

    // Zero-duration safety: if call was never connected and nothing was billed in ticks, charge is strictly ₹0.00
    const alreadyChargedAmount = Number(consultation.total_amount || 0);
    if ((!isConnectedCall || reconciledSeconds <= 0) && alreadyChargedAmount <= 0) {
      await queryPostgres(
        `UPDATE consultations
         SET state = 'ENDED', end_time = NOW(), total_duration_seconds = 0, duration_seconds = 0,
             total_amount = 0.00, platform_fee = 0.00, astrologer_earnings = 0.00, updated_at = NOW()
         WHERE id = $1`,
        [consultationId]
      );
      await queryPostgres(
        'UPDATE astrologer_profiles SET is_busy = false WHERE id = $1',
        [consultation.astrologer_id]
      );

      const zeroBillingResult: BillingResult = {
        billingId: `zero_${consultationId}`,
        consultationId,
        billedDurationSeconds: 0,
        billedMinutes: 0,
        grossAmount: 0.0,
        platformFee: 0.0,
        astrologerEarnings: 0.0,
        currency: 'INR',
        status: 'no_charge',
      };

      const io = getSocketServer();
      if (io) {
        const payload = {
          id: `sys_ended_${consultationId}`,
          _id: `sys_ended_${consultationId}`,
          consultationId,
          status: 'ENDED',
          billedMinutes: 0,
          grossAmount: 0.0,
          currency: 'INR',
        };
        io.to(`consultation_${consultationId}`)
          .to(`user_${consultation.user_id}`)
          .to(`user_${consultation.astrologer_id}`)
          .emit('consultation_ended', payload);
      }

      return zeroBillingResult;
    }

    // Execute atomic PostgreSQL reconciled billing procedure
    const billingRes = await queryPostgresSingle(
      'SELECT settle_consultation_billing_atomic($1, $2, 20.00, $3) AS id',
      [consultationId, reconciledSeconds, idempotencyKey || null]
    );

    const billingRecord = await queryPostgresSingle(
      'SELECT * FROM consultation_billing WHERE id = $1',
      [billingRes.id]
    );

    // Release astrologer busy status
    await queryPostgres(
      'UPDATE astrologer_profiles SET is_busy = false WHERE id = $1',
      [consultation.astrologer_id]
    );

    // Query customer updated wallet balance
    const updatedWallet = await queryPostgresSingle(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [consultation.user_id]
    );

    const result: BillingResult = {
      billingId: billingRecord.id,
      consultationId,
      billedDurationSeconds: billingRecord.billed_duration_seconds,
      billedMinutes: billingRecord.billed_minutes,
      grossAmount: Number(billingRecord.gross_amount),
      platformFee: Number(billingRecord.platform_fee),
      astrologerEarnings: Number(billingRecord.astrologer_earnings),
      currency: billingRecord.currency || 'INR',
      status: billingRecord.status,
    };

    console.log(
      `[BILLING] Final settlement completed: consultationId=${consultationId}, totalDuration=${result.billedDurationSeconds}s, billedMinutes=${result.billedMinutes}, totalGross=₹${result.grossAmount}, astrologerNet=₹${result.astrologerEarnings}, walletRemaining=₹${updatedWallet?.balance}`
    );

    // Broadcast socket event for real-time app update
    const io = getSocketServer();
    if (io) {
      const payload = {
        id: `sys_ended_${consultationId}`,
        _id: `sys_ended_${consultationId}`,
        consultationId,
        status: 'ENDED',
        billedMinutes: result.billedMinutes,
        grossAmount: result.grossAmount,
        currency: result.currency,
      };
      io.to(`consultation_${consultationId}`)
        .to(`user_${consultation.user_id}`)
        .to(`user_${consultation.astrologer_id}`)
        .emit('consultation_ended', payload);

      if (updatedWallet) {
        io.to(`user_${consultation.user_id}`).emit('wallet_updated', {
          balance: Number(updatedWallet.balance),
          currency: 'INR',
        });
      }
    }

    return result;
  }
}

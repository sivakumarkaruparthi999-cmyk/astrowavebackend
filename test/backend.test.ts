import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AstrologyEngineService } from '../src/services/astrology.service.js';
import { hashPassword, comparePassword, signAccessToken, verifyAccessToken } from '../src/auth/jwt.js';

describe('AstroTalk Backend Unit Tests', () => {
  it('should generate deterministic Vedic Kundli chart', () => {
    const result = AstrologyEngineService.generateKundli({
      name: 'Rahul Sharma',
      gender: 'Male',
      birthDate: '1995-08-15',
      birthTime: '06:30',
      birthPlace: 'New Delhi, India',
      latitude: 28.6139,
      longitude: 77.2090,
      timezone: 'Asia/Kolkata',
      ayanamsha: 'LAHIRI',
    });

    assert.ok(result.lagna, 'Lagna should be defined');
    assert.ok(result.moonDetails, 'Moon details should be defined');
    assert.ok(result.planets.Sun, 'Sun should be present in grahas');
    assert.ok(result.planets.Moon, 'Moon should be present in grahas');
    assert.ok(result.dashas.timeline.length > 0, 'Dasha timeline should be calculated');
    assert.strictEqual(typeof result.doshas.mangalDosha.hasMangalDosha, 'boolean');
    assert.strictEqual(typeof result.doshas.kaalSarpDosha.hasKaalSarpDosha, 'boolean');
  });

  it('should calculate deterministic Muhurat panchang windows', () => {
    const panchang = AstrologyEngineService.calculateMuhurat('2026-08-27', 28.6139, 77.2090);
    assert.ok(panchang.tithi, 'Tithi should be calculated');
    assert.ok(panchang.nakshatra, 'Nakshatra should be calculated');
    assert.ok(panchang.inauspiciousWindows.rahuKaalam, 'Rahu Kaalam should be present');
    assert.ok(panchang.auspiciousWindows.abhijitMuhurat, 'Abhijit Muhurat should be present');
  });

  it('should hash and compare passwords correctly', async () => {
    const raw = 'SuperSecurePass123!';
    const hash = await hashPassword(raw);
    assert.ok(hash !== raw, 'Hash should not match raw password');

    const isValid = await comparePassword(raw, hash);
    assert.strictEqual(isValid, true, 'Valid password should match hash');

    const isInvalid = await comparePassword('WrongPassword', hash);
    assert.strictEqual(isInvalid, false, 'Wrong password should fail');
  });

  it('should sign and verify JWT access tokens', () => {
    const payload = { userId: '11111111-1111-1111-1111-111111111111', role: 'customer' };
    const token = signAccessToken(payload);
    assert.ok(typeof token === 'string' && token.length > 20);

    const verified = verifyAccessToken(token);
    assert.strictEqual(verified.userId, payload.userId);
    assert.strictEqual(verified.role, payload.role);
  });
});

import { Router, Request, Response } from 'express';
import { AstrologyEngineService } from '../services/astrology.service.js';

const router = Router();

// 1. Generate Kundli
router.post('/kundli/generate', (req: Request, res: Response): void => {
  try {
    const { name, gender, birth_date, birth_time, birth_place, latitude, longitude, timezone, ayanamsha } = req.body;

    if (!name || !birth_date || !birth_time || !birth_place || latitude === undefined || longitude === undefined) {
      res.status(400).json({ success: false, error: 'Missing required birth parameters' });
      return;
    }

    // Strict schema and bounds validation
    if (typeof birth_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birth_date) || isNaN(Date.parse(birth_date))) {
      res.status(400).json({ success: false, error: 'Invalid birth_date format (expected YYYY-MM-DD)' });
      return;
    }

    if (typeof birth_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(birth_time)) {
      res.status(400).json({ success: false, error: 'Invalid birth_time format (expected HH:mm or HH:mm:ss in 24-hour time)' });
      return;
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (isNaN(lat) || lat < -90 || lat > 90) {
      res.status(400).json({ success: false, error: 'Invalid latitude (must be a valid number between -90 and 90)' });
      return;
    }
    if (isNaN(lng) || lng < -180 || lng > 180) {
      res.status(400).json({ success: false, error: 'Invalid longitude (must be a valid number between -180 and 180)' });
      return;
    }

    const data = AstrologyEngineService.generateKundli({
      name,
      gender,
      birthDate: birth_date,
      birthTime: birth_time,
      birthPlace: birth_place,
      latitude: lat,
      longitude: lng,
      timezone: timezone || 'Asia/Kolkata',
      ayanamsha: ayanamsha || 'LAHIRI',
    });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 2. Interpret Chart
router.post('/interpret', (req: Request, res: Response): void => {
  try {
    const { lagna, moon_rashi, current_dasha, doshas } = req.body;

    res.status(200).json({
      success: true,
      data: {
        summary: `Birth chart with Lagna in ${lagna?.rashiEnglish || 'Aries'} and Moon in ${moon_rashi?.rashiEnglish || 'Taurus'}.`,
        personality: 'Strong leadership traits, intuitive decision making, and deep spiritual inclination.',
        careerRecommendation: 'Recommended fields: Advisory, Technology, Finance, Spiritual leadership.',
        dashaInfluence: `Currently undergoing ${current_dasha?.lord || 'Venus'} Mahadasha promoting growth and stability.`,
        doshaAnalysis: doshas?.mangalDosha?.hasMangalDosha
          ? 'Mild Mangal Dosha present. Performing Tuesday prayers or Hanuman Chalisa recitation is auspicious.'
          : 'No major malefic planetary afflictions detected.',
        disclaimer: 'Astrological interpretations are advisory and non-deterministic guidance tools.',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 3. Muhurat Calculate
router.post('/muhurat/calculate', (req: Request, res: Response): void => {
  try {
    const { date, latitude = 28.6139, longitude = 77.2090 } = req.body;
    const dateStr = date || new Date().toISOString().split('T')[0];

    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(Date.parse(dateStr))) {
      res.status(400).json({ success: false, error: 'Invalid date format (expected YYYY-MM-DD)' });
      return;
    }
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (isNaN(lat) || lat < -90 || lat > 90) {
      res.status(400).json({ success: false, error: 'Invalid latitude (must be a valid number between -90 and 90)' });
      return;
    }
    if (isNaN(lng) || lng < -180 || lng > 180) {
      res.status(400).json({ success: false, error: 'Invalid longitude (must be a valid number between -180 and 180)' });
      return;
    }

    const data = AstrologyEngineService.calculateMuhurat(dateStr, lat, lng);
    res.status(200).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;

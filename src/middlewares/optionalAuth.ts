import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

/** Parses JWT when present; never rejects unauthenticated requests. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const hdr = req.headers.authorization || '';
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : queryToken;
    if (token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
      (req as any).auth = {
        userId: Number(payload.sub || payload.uid),
        role: payload.role || 'user',
      };
    }
  } catch { /* invalid token → treat as anonymous */ }
  next();
}
// src/middlewares/requireAuth.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, msg: "no token" });
    const payload = jwt.verify(token, process.env.JWT_SECRET! ) as any;
    (req as any).auth = { userId: Number(payload.sub || payload.uid) };
    next();
  } catch {
    res.status(401).json({ ok: false, msg: "invalid token" });
  }
}

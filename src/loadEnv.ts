// src/loadEnv.ts
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load .env from the project root relative to the compiled JS file
dotenv.config({ path: path.resolve(__dirname, "../.env") });

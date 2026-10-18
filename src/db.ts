import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

export const pool = mysql.createPool({
  host: process.env.MYSQL_HOST!,
  // MariaDB en Coolify expone un puerto distinto de 3306 (MYSQL_PORT); sin la variable, el estándar.
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER!,
  password: process.env.MYSQL_PASSWORD!,
  database: process.env.MYSQL_DB!,
  connectionLimit: 10,
  namedPlaceholders: true
});

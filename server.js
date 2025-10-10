// Archivo: /server/server.js
// Carga las variables de entorno del archivo .env
require('dotenv').config({ path: './.env' }); 

const express = require('express');
const cors = require('cors'); 
const { Pool } = require('pg');
//const os = require('os');
// const session = require('express-session'); // <-- ELIMINADO
// const pgSession = require('connect-pg-simple')(session); // <-- ELIMINADO

const app = express();
const PORT = 3001; // Puerto interno de Node.js (CAMBIO)
const INTERNAL_HOST = '0.0.0.0'; // Escuchar en todas las interfaces internas

// CLAVE SECRETA DE JWT (¡REEMPLAZAR CON process.env.JWT_SECRET!)
// Por simplicidad, se define aquí, pero DEBE ser una variable de entorno.
const JWT_SECRET = 'TuSuperClaveSecretaJWT9876543210'; 

// ====================================================
// CONFIGURACIÓN DE BASE DE DATOS (POSTGRESQL - USANDO URL)
// ====================================================
if (!process.env.DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL no está definido en el archivo .env');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Para desarrollo, necesario con certificados Aiven
    }
});

pool.connect()
    .then(client => {
        console.log('✅ Conexión exitosa a PostgreSQL.');
        client.release();
    })
    .catch(err => {
        console.error('❌ Error de conexión a PostgreSQL:', err.stack);
        process.exit(1);
    });

// ====================================================
// CONFIGURACIÓN CORS (Para Dominio HTTPS Real)
// ====================================================
const PRODUCTION_API_URL = 'https://davcenter.servequake.com';

const corsOptions = {
    // Permitir acceso desde la app (HTTPS) y localhost (para depuración)
    // Se mantiene 'credentials: true' en CORS por si acaso, aunque ya no enviamos la cookie de sesión
    origin: [PRODUCTION_API_URL, 'https://localhost', 'http://localhost', 'http://127.0.0.1:3000'], 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'], // <-- Authorization AÑADIDO
    credentials: true 
};

app.use(cors(corsOptions)); 

// Middleware para procesar JSON
app.use(express.json());

// ====================================================
// CONFIGURACIÓN DE SESIÓN (ELIMINADA - USANDO JWT)
// ====================================================
// Bloque de sesión ELIMINADO

// ====================================================
// INICIALIZACIÓN DE TABLAS y RUTAS
// ====================================================

async function createUsersTable() {
    const query = `
        CREATE TABLE IF NOT EXISTS usersapp (
            id SERIAL PRIMARY KEY,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            
            -- CAMPOS NUEVOS:
            username VARCHAR(50) UNIQUE,           -- <-- CLAVE: UNIQUE y puede ser NULL al inicio
            age INTEGER,
            gender VARCHAR(10),
            profile_pic_url VARCHAR(255)           -- URL de la imagen (dejar NULL)
        );
    `;
    try {
        await pool.query(query);
        console.log('✅ Tabla "usersapp" verificada o creada con campos de perfil.'); // Mensaje actualizado
    } catch (err) {
        console.error('❌ Error al crear la tabla "usersapp":', err.stack); 
    }
}
createUsersTable(); 

// Rutas
const authRoutes = require('./api/auth');
const userRoutes = require('./api/user'); 
// Pasamos el pool y el JWT_SECRET
app.use('/api/auth', authRoutes(pool, JWT_SECRET)); 
app.use('/api/user', userRoutes(pool, JWT_SECRET)); 

// Manejador de Errores Final (Evita devolver HTML)
app.use((err, req, res, next) => {
    console.error(err.stack);
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
        success: false,
        message: err.message || 'Error interno del servidor.',
    });
});


// Servidor de escucha
app.listen(PORT, INTERNAL_HOST, () => {
    console.log(`📡 Servidor de Node.js escuchando INTERNAMENTE en ${INTERNAL_HOST}:${PORT}`);
    console.log(`🌐 Acceso EXTERNO (APP) vía: ${PRODUCTION_API_URL}`);
});
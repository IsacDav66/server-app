// Archivo: /server/server.js
// Carga las variables de entorno del archivo .env
require('dotenv').config({ path: './.env' }); 

const express = require('express');
const cors = require('cors'); 
const { Pool } = require('pg');
//const os = require('os');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session); 

const app = express();
const PORT = 3001; // Puerto interno de Node.js
const INTERNAL_HOST = '0.0.0.0'; // Escuchar en todas las interfaces internas

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
    origin: [PRODUCTION_API_URL, 'https://localhost', 'http://localhost'], 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
    credentials: true // CLAVE: Permite el envío de cookies/sesiones
};

// **DEJA ESTO:** El middleware cors manejará todas las solicitudes,
// incluyendo las preflight OPTIONS, para las rutas definidas.
app.use(cors(corsOptions)); 

// **ELIMINA O COMENTA ESTA LÍNEA** para resolver el PathError:
// app.options('*', cors(corsOptions)); 

// Middleware para procesar JSON
app.use(express.json());

// ====================================================
// CONFIGURACIÓN DE SESIÓN (Middleware)
// ====================================================

const SESSION_SECRET = 'EstaEsUnaClaveSuperSecretaParaSesionesDeExpress12345'; 

const sessionStore = new pgSession({
    pool: pool, 
    tableName: 'user_sessions', 
    createTableIfMissing: true
});

app.use(session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false, 
    cookie: { 
        maxAge: 30 * 24 * 60 * 60 * 1000, 
        secure: true, // CLAVE: Debe ser TRUE para HTTPS (el dominio)
        httpOnly: true, // CRÍTICO: Debe ser TRUE (por seguridad), pero false para el WebView. Usaremos 'false' por compatibilidad con el WebView.
        sameSite: 'None' // CLAVE para solicitudes cross-site (la app)
    }
}));


// ====================================================
// INICIALIZACIÓN DE TABLAS y RUTAS
// ====================================================
// ... (Tu función createUsersTable) ...

async function createUsersTable() {
    const query = `
        CREATE TABLE IF NOT EXISTS usersapp (
            id SERIAL PRIMARY KEY,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        await pool.query(query);
        console.log('✅ Tabla "usersapp" verificada o creada.'); 
    } catch (err) {
        console.error('❌ Error al crear la tabla "usersapp":', err.stack); 
    }
}
createUsersTable(); 

// Rutas
const authRoutes = require('./api/auth');
const userRoutes = require('./api/user'); 
app.use('/api/auth', authRoutes(pool)); 
app.use('/api/user', userRoutes(pool)); 

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
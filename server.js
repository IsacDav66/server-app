// Archivo: /server/server.js
// Carga las variables de entorno del archivo .env
require('dotenv').config({ path: './.env' }); 

const express = require('express');
const cors = require('cors'); 
const { Pool } = require('pg');
const path = require('path'); // <-- CLAVE: Módulo Path
const bodyParser = require('body-parser'); // <-- 1. IMPORTAR BODY-PARSER

const app = express();
const PORT = 3001;
const INTERNAL_HOST = '0.0.0.0'; 

// CLAVE SECRETA DE JWT (¡USAR .ENV EN PRODUCCIÓN!)
const JWT_SECRET = 'TuSuperClaveSecretaJWT9876543210'; 

// ====================================================
// CONFIGURACIÓN DE BASE DE DATOS (POSTGRESQL)
// ====================================================
if (!process.env.DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL no está definido en el archivo .env');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
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
// CONFIGURACIÓN DE MIDDLEWARE (SECCIÓN ACTUALIZADA)
// ====================================================
const PRODUCTION_API_URL = 'https://davcenter.servequake.com';

const corsOptions = {
    origin: [PRODUCTION_API_URL, 'https://localhost', 'http://localhost', 'http://127.0.0.1:3000','http://127.0.0.1:5500'], 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true 
};

// 2. AÑADIR BODY-PARSER CON LÍMITES AMPLIADOS (ANTES DE CORS)
// Aumentamos el límite para poder subir videos grandes. 50mb es un buen punto de partida.
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// 3. APLICAR CORS
app.use(cors(corsOptions)); 

// 4. AÑADIR UN MANEJADOR EXPLÍCITO PARA LAS SOLICITUDES OPTIONS
// Esto actúa como un seguro para garantizar que las preflight requests siempre funcionen.
app.options('*', cors(corsOptions));

// Middleware para procesar JSON (ya no es necesario si usas bodyParser)
// app.use(express.json()); // <-- PUEDES COMENTAR O ELIMINAR ESTA LÍNEA

// Servir archivos estáticos (sin cambios)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));  

// ====================================================
// INICIALIZACIÓN DE TABLAS
// ====================================================

async function initDatabase() {
    // 1. TABLA PRINCIPAL DE USUARIOS (usersapp)
    const usersQuery = `
        CREATE TABLE IF NOT EXISTS usersapp (
            id SERIAL PRIMARY KEY,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255),
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            username VARCHAR(50) UNIQUE,           
            age INTEGER,
            gender VARCHAR(10),
            profile_pic_url VARCHAR(255)
        );
    `;

    // 2. TABLA DE PUBLICACIONES (postapp)
    const postQuery = `
        CREATE TABLE IF NOT EXISTS postapp (
            post_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            content TEXT,
            image_url VARCHAR(255),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // 3. TABLA DE REACCIONES (post_reactionapp)
    const reactionQuery = `
        CREATE TABLE IF NOT EXISTS post_reactionapp (
            reaction_id SERIAL PRIMARY KEY,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            reaction_type VARCHAR(10) NOT NULL, -- Ej: 'like', 'love', 'haha'
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (post_id, user_id)
        );
    `;

    // 4. TABLA DE POSTS GUARDADOS (saved_postsapp)
    const savedQuery = `
        CREATE TABLE IF NOT EXISTS saved_postsapp (
            saved_post_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, post_id)
        );
    `;

    // 5. TABLA DE COMENTARIOS (commentsapp)
    const commentsQuery = `
        CREATE TABLE IF NOT EXISTS commentsapp (
            comment_id SERIAL PRIMARY KEY,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            parent_comment_id INTEGER REFERENCES commentsapp(comment_id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;


   // 6. TABLA DE SEGUIDORES (followersapp) - NUEVA
    const followersQuery = `
        CREATE TABLE IF NOT EXISTS followersapp (
            follower_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            following_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (follower_id, following_id)
        );
    `;

    try {
        await pool.query(usersQuery);
        console.log('✅ Tabla "usersapp" verificada/creada.');
        await pool.query(postQuery);
        console.log('✅ Tabla "postapp" verificada/creada.');
        await pool.query(reactionQuery);
        console.log('✅ Tabla "post_reactionapp" verificada/creada.');
        await pool.query(savedQuery);
        console.log('✅ Tabla "saved_postsapp" verificada/creada.');
        await pool.query(commentsQuery);
        console.log('✅ Tabla "commentsapp" verificada/creada.');
        await pool.query(followersQuery);
        console.log('✅ Tabla "followersapp" verificada/creada.');
    } catch (err) {
        console.error('❌ Error al inicializar la base de datos:', err.stack);
        // NO HACEMOS process.exit(1) si es un error al crear, ya que puede que la tabla ya exista.
        // Si tienes problemas, ejecuta un DROP TABLE si estás en desarrollo.
    }
}
initDatabase(); // <-- LLAMAR A LA FUNCIÓN

// Rutas
const authRoutes = require('./api/auth');
const userRoutes = require('./api/user'); 
const postRoutes = require('./api/post'); // <-- NUEVA RUTA DE POSTS
// Pasamos el pool y el JWT_SECRET
app.use('/api/auth', authRoutes(pool, JWT_SECRET)); 
app.use('/api/user', userRoutes(pool, JWT_SECRET)); 
app.use('/api/posts', postRoutes(pool, JWT_SECRET)); // <-- RUTA BASE PARA PUBLICACIONES

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
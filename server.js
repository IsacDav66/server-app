// Archivo: /server/server.js (VERSIÓN CON CORS MANUAL)
// Carga las variables de entorno del archivo .env
require('dotenv').config({ path: './.env' }); 

const express = require('express');
// const cors = require('cors'); // Ya no se necesita
const { Pool } = require('pg');
const path = require('path');
// const bodyParser = require('body-parser'); // Usaremos el de Express integrado
const http = require('http'); // <-- AÑADE ESTA LÍNEA
const { Server } = require("socket.io"); // <-- AÑADE ESTA LÍNEA
const admin = require('firebase-admin'); // <-- 1. IMPORTA FIREBASE ADMIN


const app = express();
const PORT = 3001;
const INTERNAL_HOST = '0.0.0.0'; 

// CLAVE SECRETA DE JWT (¡USAR .ENV EN PRODUCCIÓN!)
const JWT_SECRET = 'TuSuperClaveSecretaJWT9876543210'; 

// --- CREA UN SERVIDOR HTTP Y ENVUELVE TU APP DE EXPRESS ---
const server = http.createServer(app);

// --- CONFIGURA SOCKET.IO CON CORS ---
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    // ¡LA LÍNEA CLAVE!
    path: "/app/socket.io/"
});

// ==========================================================
// === ¡AQUÍ ESTÁ LA LÍNEA MÁGICA QUE SOLUCIONA EL BUG! ===
// ==========================================================
app.set('socketio', io);
// ==========================================================

// ==========================================================
// === INICIALIZACIÓN DE FIREBASE ADMIN (SOLO UNA VEZ) ===
// ==========================================================
try {
    const serviceAccount = require('./config/firebase-service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK inicializado correctamente.');
} catch (error) {
    console.error('❌ Error al inicializar Firebase Admin SDK:', error.message);
    // Podrías decidir salir del proceso si Firebase es crítico
    // process.exit(1); 
}
// ==========================================================


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
// CONFIGURACIÓN DE MIDDLEWARE
// ====================================================

// Aumentamos el límite del cuerpo de la solicitud para poder subir videos grandes.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// ====================================================
// CONFIGURACIÓN DE MIDDLEWARE (VERSIÓN FINAL Y SIMPLIFICADA)
// ====================================================

// Solo necesitamos el parser para cuerpos de solicitud grandes.
// Nginx se encargará de todo lo relacionado con CORS.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Servir archivos estáticos (sin cambios)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));



// --- LÓGICA DE WEBSOCKETS (Pega esto después de tus middlewares) ---
io.on('connection', (socket) => {
    console.log('🔌 Un usuario se ha conectado:', socket.id);

    // --- NUEVA LÓGICA DE AUTENTICACIÓN Y SALA ---
    // El cliente debe emitir este evento justo después de conectarse
    socket.on('authenticate', (token) => {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.userId) {
                const userRoom = `user-${decoded.userId}`;
                socket.join(userRoom);
                console.log(`Socket ${socket.id} autenticado y unido a la sala ${userRoom}`);
            }
        } catch (error) {
            console.log(`Fallo de autenticación para socket ${socket.id}`);
        }
    });
    // --- FIN DE LA NUEVA LÓGICA ---

    // El cliente se une a una sala privada al conectarse
    socket.on('join_room', (roomName) => {
        socket.join(roomName);
        console.log(`Socket ${socket.id} se unió a la sala: ${roomName}`);
    });

    // Escucha los mensajes entrantes del cliente
    socket.on('send_message', async (data) => {
        // Obtenemos los datos del cliente, incluyendo el ID temporal
        const { sender_id, receiver_id, content, roomName, parent_message_id, message_id: tempId } = data;

        try {
            // 1. Guardar el nuevo mensaje en la base de datos
            const insertQuery = 'INSERT INTO messagesapp (sender_id, receiver_id, content, parent_message_id) VALUES ($1, $2, $3, $4) RETURNING *';
            const insertResult = await pool.query(insertQuery, [sender_id, receiver_id, content, parent_message_id || null]);
            let savedMessage = insertResult.rows[0]; // Usamos 'let' para poder modificar el objeto

            // =========================================================
            // === INICIO DE LA LÓGICA DE "ENRIQUECIMIENTO" ===
            // =========================================================
            // 2. Si el mensaje que acabamos de guardar es una respuesta...
            if (savedMessage.parent_message_id) {
                // ...hacemos una consulta extra para obtener los datos del mensaje original.
                const parentQuery = `
                    SELECT 
                        p.content as parent_content,
                        pu.username as parent_username
                    FROM messagesapp AS p
                    JOIN usersapp AS pu ON p.sender_id = pu.id
                    WHERE p.message_id = $1;
                `;
                const parentResult = await pool.query(parentQuery, [savedMessage.parent_message_id]);
                
                if (parentResult.rows.length > 0) {
                    // Añadimos las propiedades 'parent_content' y 'parent_username'
                    // al objeto 'savedMessage' antes de enviarlo.
                    savedMessage.parent_content = parentResult.rows[0].parent_content;
                    savedMessage.parent_username = parentResult.rows[0].parent_username;
                }
            }
            // =========================================================
            // === FIN DE LA LÓGICA DE "ENRIQUECIMIENTO" ===
            // =========================================================

            // 3. Emitimos el mensaje (ahora "enriquecido") al otro usuario en la sala
            socket.to(roomName).emit('receive_message', savedMessage);

            // 4. Enviamos la confirmación al emisor original con el mismo objeto enriquecido
            socket.emit('message_confirmed', {
                tempId: tempId,
                realMessage: savedMessage
            });
            // ==========================================================
            // === ¡NUEVA LÓGICA DE NOTIFICACIÓN PUSH PARA MENSAJES! ===
            // ==========================================================
            try {
                // A. Obtener los datos del destinatario (token FCM) y del remitente (nombre, foto)
                const recipientResult = await pool.query('SELECT fcm_token FROM usersapp WHERE id = $1', [receiver_id]);
                const senderResult = await pool.query('SELECT username, profile_pic_url FROM usersapp WHERE id = $1', [sender_id]);

                const recipient = recipientResult.rows[0];
                const sender = senderResult.rows[0];

                // B. Si el destinatario tiene un token FCM, enviar la notificación
                if (recipient && recipient.fcm_token) {
                    
                    // C. Construir el payload del mensaje para Firebase
                    const message = {
                        token: recipient.fcm_token,
                        notification: {
                            title: sender.username, // El título es el nombre del remitente
                            body: content, // El cuerpo es el contenido del mensaje
                        },
                        data: {
                            senderId: String(sender_id),
                            // Acción de clic: abrir el chat con el remitente
                            openUrl: `chat.html?userId=${sender_id}` 
                        },
                        android: {
                            notification: {
                                // Usamos 'imageUrl' para que Android muestre el avatar
                            }
                        }
                    };
                    
                    // D. Añadir la imagen de perfil si existe
                    if (sender.profile_pic_url) {
                        const fullImageUrl = (process.env.PUBLIC_SERVER_URL + sender.profile_pic_url).trim();
                        message.android.notification.imageUrl = fullImageUrl;
                        message.data.imageUrl = fullImageUrl;
                    }

                    // E. Enviar la notificación push
                    await admin.messaging().send(message);
                    console.log(`Notificación push de mensaje enviada al usuario ${receiver_id}`);
                }
            } catch (pushError) {
                console.error("Error al enviar la notificación push del mensaje:", pushError);
            }
            // ==========================================================

        } catch (error) {
            console.error("Error al guardar o enviar el mensaje:", error);
        }
    });



    socket.on('disconnect', () => {
        console.log('🔌 Un usuario se ha desconectado:', socket.id);
    });
});




// ====================================================
// INICIALIZACIÓN DE TABLAS
// ====================================================

async function initDatabase() {
    // TABLA DE USUARIOS (usersapp)
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

    // TABLA DE PUBLICACIONES (postapp)
    const postQuery = `
        CREATE TABLE IF NOT EXISTS postapp (
            post_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            content TEXT,
            image_url VARCHAR(255),
            video_id VARCHAR(255), -- Columna para el ID de video de YouTube
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // TABLA DE REACCIONES (post_reactionapp)
    const reactionQuery = `
        CREATE TABLE IF NOT EXISTS post_reactionapp (
            reaction_id SERIAL PRIMARY KEY,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            reaction_type VARCHAR(10) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (post_id, user_id)
        );
    `;

    // TABLA DE POSTS GUARDADOS (saved_postsapp)
    const savedQuery = `
        CREATE TABLE IF NOT EXISTS saved_postsapp (
            saved_post_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, post_id)
        );
    `;

    // TABLA DE COMENTARIOS (commentsapp)
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

    // TABLA DE SEGUIDORES (followersapp)
    const followersQuery = `
        CREATE TABLE IF NOT EXISTS followersapp (
            follower_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            following_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (follower_id, following_id)
        );
    `;

    // --- AÑADE ESTE BLOQUE COMPLETO ---
    const messagesQuery = `
        CREATE TABLE IF NOT EXISTS messagesapp (
            message_id SERIAL PRIMARY KEY,
            sender_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            receiver_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    // --- FIN DEL BLOQUE A AÑADIR ---

    // TABLA DE NOTIFICACIONES (notificationsapp)
    const notificationsQuery = `
        CREATE TABLE IF NOT EXISTS notificationsapp (
            notification_id SERIAL PRIMARY KEY,
            recipient_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL, -- Quién recibe la notificación
            sender_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,    -- Quién la originó
            type VARCHAR(20) NOT NULL, -- 'new_follower', 'like', 'comment'
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE, -- Opcional, para likes/comentarios
            is_read BOOLEAN DEFAULT FALSE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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
        // --- AÑADE ESTA LÍNEA ---
        await pool.query(messagesQuery);
        console.log('✅ Tabla "messagesapp" verificada/creada.');
        
        await pool.query(notificationsQuery);
        console.log('✅ Tabla "notificationsapp" verificada/creada.');
    } catch (err) {
        console.error('❌ Error al inicializar la base de datos:', err.stack);
    }
}
initDatabase();

// Rutas
const authRoutes = require('./api/auth');
const userRoutes = require('./api/user'); 
const postRoutes = require('./api/post');
app.use('/api/auth', authRoutes(pool, JWT_SECRET)); 
app.use('/api/user', userRoutes(pool, JWT_SECRET)); 
app.use('/api/posts', postRoutes(pool, JWT_SECRET));

const chatRoutes = require('./api/chat'); // <-- AÑADE

// --- AÑADE LA NUEVA RUTA ---
const notificationRoutes = require('./api/notifications');
app.set('socketio', io); // <-- AÑADE ESTA LÍNEA
app.use('/api/notifications', notificationRoutes(pool, JWT_SECRET));
app.use('/api/chat', chatRoutes(pool, JWT_SECRET, io)); // <-- Pasamos 'io' como argumento

// Manejador de Errores Final
app.use((err, req, res, next) => {
    console.error(err.stack);
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
        success: false,
        message: err.message || 'Error interno del servidor.',
    });
});

// Servidor de escucha
const PRODUCTION_API_URL = 'https://davcenter.servequake.com';
server.listen(PORT, INTERNAL_HOST, () => {
    console.log(`📡 Servidor de Node.js escuchando INTERNAMENTE en ${INTERNAL_HOST}:${PORT}`);
    console.log(`🌐 Acceso EXTERNO (APP) vía: ${PRODUCTION_API_URL}`);
});
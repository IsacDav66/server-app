// Carga las variables de entorno del archivo .env
require('dotenv').config({ path: './.env' }); 

// --- IMPORTACIONES ---
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const admin = require('firebase-admin');

// --- CONFIGURACIÓN PRINCIPAL ---
const app = express();
const PORT = 3001;
const INTERNAL_HOST = '0.0.0.0'; 
const JWT_SECRET = 'TuSuperClaveSecretaJWT9876543210'; // ¡Usa process.env.JWT_SECRET en producción!

const server = http.createServer(app);

// --- CONFIGURACIÓN DE SOCKET.IO ---
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    path: "/app/socket.io/"
});
app.set('socketio', io);

// --- INICIALIZACIÓN DE FIREBASE ADMIN ---
try {
    const serviceAccount = require('./config/firebase-service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK inicializado correctamente.');
} catch (error) {
    console.error('❌ Error al inicializar Firebase Admin SDK:', error.message);
}

// --- CONFIGURACIÓN DE BASE DE DATOS ---
if (!process.env.DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL no está definido en el archivo .env');
    process.exit(1);
}
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
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

// --- CONFIGURACIÓN DE MIDDLEWARE ---

// ==========================================================
// === ¡AÑADE ESTE BLOQUE PARA HABILITAR SharedArrayBuffer! ===
// ==========================================================
// Este middleware añade las cabeceras necesarias para el aislamiento de origen cruzado.
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
});
// ==========================================================

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/updates', express.static(path.join(__dirname, 'public', 'updates')));

// --- MAPA DE USUARIOS EN LÍNEA ---
const onlineUsers = new Map();
app.set('onlineUsers', onlineUsers);

// --- LÓGICA DE WEBSOCKETS ---
io.on('connection', (socket) => {
    console.log('🔌 Un usuario se ha conectado:', socket.id);

    const notifyFriendsOfStatusChange = async (userId, isOnline, currentAppInfo = null) => {
        try {
            const query = `
                SELECT f1.follower_id as friend_id
                FROM followersapp f1
                INNER JOIN followersapp f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
                WHERE f1.following_id = $1;
            `;
            const result = await pool.query(query, [userId]);
            const friends = result.rows;
            if (friends.length === 0) return;

            const payload = { 
                userId: userId, 
                isOnline: isOnline,
                currentApp: currentAppInfo ? currentAppInfo.name : null,
                currentAppIcon: currentAppInfo ? currentAppInfo.icon : null,
                currentAppPackage: currentAppInfo ? currentAppInfo.package : null
            };

            friends.forEach(friend => {
                const friendRoom = `user-${friend.friend_id}`;
                io.to(friendRoom).emit('friend_status_update', payload);
            });
        } catch (error) {
            console.error("❌ Error en notifyFriendsOfStatusChange:", error);
        }
    };

    socket.on('authenticate', (token) => {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.userId) {
                const userId = decoded.userId;
                socket.userId = userId;
                const userRoom = `user-${userId}`;
                socket.join(userRoom);
                onlineUsers.set(socket.id, { userId: userId, currentApp: null });
                console.log(`✅ Socket ${socket.id} autenticado como user ${userId} y unido a la sala ${userRoom}`);
                notifyFriendsOfStatusChange(userId, true, null);
            }
        } catch (error) {
            console.log(`❌ Fallo de autenticación para socket ${socket.id}`);
        }
    });

    socket.on('update_current_app', async (appData) => {
        if (!socket.userId) return;
        let finalAppData = null;
        if (appData && appData.package) {
            try {
                const result = await pool.query('SELECT * FROM detected_apps WHERE package_name = $1', [appData.package]);
                if (result.rows.length > 0) {
                    const dbApp = result.rows[0];
                    finalAppData = { name: dbApp.app_name, package: dbApp.package_name, icon: dbApp.icon_url, is_game: dbApp.is_game };
                    
                    // Registrar en historial de apps
                    const upsertHistoryQuery = `INSERT INTO user_app_history (user_id, package_name, last_seen_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (user_id, package_name) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP;`;
                    await pool.query(upsertHistoryQuery, [socket.userId, dbApp.package_name]);

                    // Si es un juego, registrar en historial de juegos
                    if (dbApp.is_game === true) {
                        const upsertGameQuery = `INSERT INTO user_played_games (user_id, package_name, last_played_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (user_id, package_name) DO UPDATE SET last_played_at = CURRENT_TIMESTAMP;`;
                        await pool.query(upsertGameQuery, [socket.userId, dbApp.package_name]);
                    }
                } else {
                    finalAppData = { name: appData.name, package: appData.package, icon: null, unregistered: true };
                }
            } catch (dbError) {
                console.error("❌ Error al buscar/registrar app en la BD:", dbError);
                finalAppData = { name: appData.name, package: appData.package, icon: null };
            }
        }
        
        const userData = onlineUsers.get(socket.id);
        if (userData && (userData.currentApp?.package !== finalAppData?.package)) {
            userData.currentApp = finalAppData;
            onlineUsers.set(socket.id, userData);
            notifyFriendsOfStatusChange(socket.userId, true, finalAppData);
        }
    });

    socket.on('join_room', (roomName) => {
        socket.join(roomName);
        console.log(`Socket ${socket.id} se unió a la sala: ${roomName}`);
    });

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
    
                    // CONSTRUIMOS EL PAYLOAD DE "SOLO DATOS"
                    const message = {
                        token: recipient.fcm_token,
                        // ¡¡¡ELIMINAMOS EL CAMPO "notification"!!!
                        
                        // Toda la información visual va DENTRO del campo "data"
                        data: {
                            // Datos para que el cliente construya la notificación
                            title: sender.username,
                            body: content,
                            channelId: 'chat_messages_channel', // Le decimos qué canal usar
                            
                            // Datos para el agrupamiento
                            groupId: String(sender_id), // El ID del remitente es el grupo
                            
                            // Datos para la acción de clic
                            senderId: String(sender_id),
                            openUrl: `chat.html?userId=${sender_id}` 
                        },
                        
                        // Podemos seguir usando las opciones de Android para la prioridad
                        android: {
                            priority: 'high' // Asegura la entrega rápida
                        }
                    };
                    
                    // Añadir la imagen de perfil (sin cambios)
                    if (sender.profile_pic_url) {
                        const fullImageUrl = (process.env.PUBLIC_SERVER_URL + sender.profile_pic_url).trim();
                        // La enviamos solo en el campo `data`
                        message.data.imageUrl = fullImageUrl;
                    }

                    await admin.messaging().send(message);
                    console.log(`Notificación de DATOS de mensaje enviada al usuario ${receiver_id}`);
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
        console.log(`🔌 Un usuario se ha desconectado: ${socket.id}`);
        if (socket.userId) {
            onlineUsers.delete(socket.id);
            notifyFriendsOfStatusChange(socket.userId, false, null);
        }
    });
});

// --- INICIALIZACIÓN DE TABLAS DE LA BASE DE DATOS ---
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
    
    // AÑADE ESTA QUERY
     // AÑADE ESTA QUERY
    const detectedAppsQuery = `
        CREATE TABLE IF NOT EXISTS detected_apps (
            package_name VARCHAR(255) PRIMARY KEY,
            app_name VARCHAR(100) NOT NULL,
            icon_url VARCHAR(255),
            added_by_user_id INTEGER REFERENCES usersapp(id),
            is_game BOOLEAN DEFAULT NULL, -- <-- ¡NUEVA COLUMNA!
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

     // ==========================================================
    // === ¡NUEVA TABLA PARA REGISTRAR JUEGOS JUGADOS! ===
    // ==========================================================
    const userPlayedGamesQuery = `
        CREATE TABLE IF NOT EXISTS user_played_games (
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            package_name VARCHAR(255) REFERENCES detected_apps(package_name) ON DELETE CASCADE NOT NULL,
            last_played_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, package_name)
        );
    `;
    // ==========================================================

    
     // ==========================================================
    // === ¡NUEVA TABLA PARA EL HISTORIAL DE APPS DEL USUARIO! ===
    // ==========================================================
    const userAppHistoryQuery = `
        CREATE TABLE IF NOT EXISTS user_app_history (
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            package_name VARCHAR(255) REFERENCES detected_apps(package_name) ON DELETE CASCADE NOT NULL,
            last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, package_name)
        );
    `;
    // ==========================================================
    // ==========================================================
    // === ¡NUEVA TABLA PARA LAS TARJETAS DE JUGADOR! ===
    // ==========================================================
    const playerCardsQuery = `
        CREATE TABLE IF NOT EXISTS player_cards (
            card_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            package_name VARCHAR(255) REFERENCES detected_apps(package_name) ON DELETE CASCADE NOT NULL,
            in_game_username VARCHAR(100),
            in_game_id VARCHAR(100),
            invite_link TEXT,
            cover_image_url VARCHAR(255),
            
            -- ¡NUEVA COLUMNA PARA EL ORDEN! --
            display_order INTEGER NOT NULL DEFAULT 0,

            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, package_name)
        );
    `;
    // ==========================================================

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
        
        // AÑADE ESTA LLAMADA
        await pool.query(detectedAppsQuery);
        console.log('✅ Tabla "detected_apps" verificada/creada.');
    
        // --- AÑADE ESTA LLAMADA ---
        await pool.query(userPlayedGamesQuery);
        console.log('✅ Tabla "user_played_games" verificada/creada.');

        // --- AÑADE ESTA LLAMADA ---
        await pool.query(userAppHistoryQuery);
        console.log('✅ Tabla "user_app_history" verificada/creada.');
        // --- AÑADE ESTA LLAMADA ---
        await pool.query(playerCardsQuery);
        console.log('✅ Tabla "player_cards" verificada/creada.');
    } catch (err) {
        console.error('❌ Error al inicializar la base de datos:', err.stack);
    }
}
initDatabase();

// --- RUTAS DE LA APLICACIÓN ---
const authRoutes = require('./api/auth');
const userRoutes = require('./api/user'); 
const postRoutes = require('./api/post');
const chatRoutes = require('./api/chat');
const notificationRoutes = require('./api/notifications');
const appApiRoutes = require('./api/apps');

// Montamos cada router en su prefijo correcto
app.use('/api/auth', authRoutes(pool, JWT_SECRET)); 
app.use('/api/user', userRoutes(pool, JWT_SECRET)); 
app.use('/api/posts', postRoutes(pool, JWT_SECRET));
app.use('/api/notifications', notificationRoutes(pool, JWT_SECRET));
app.use('/api/chat', chatRoutes(pool, JWT_SECRET, io));

// ¡LLAMADA SIMPLIFICADA! Ya no pasamos 'fetch'
app.use('/api/apps', appApiRoutes(pool, JWT_SECRET)); 


// Ruta específica para la versión de la app
app.get('/api/app/latest-version', (req, res) => {
    const versionFilePath = path.join(__dirname, 'public', 'updates', 'version.json');
    fs.readFile(versionFilePath, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).json({ success: false, message: "No se pudo obtener la información de la versión." });
        }
        try {
            const versionInfo = JSON.parse(data);
            versionInfo.downloadUrl = `${process.env.PUBLIC_SERVER_URL}/updates/app-release.apk`;
            res.json({ success: true, ...versionInfo });
        } catch (parseErr) {
            res.status(500).json({ success: false, message: "Archivo de versión corrupto." });
        }
    });
});

// --- MANEJADOR DE ERRORES FINAL ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
        success: false,
        message: err.message || 'Error interno del servidor.',
    });
});

// --- SERVIDOR DE ESCUCHA ---
const PRODUCTION_API_URL = 'https://davcenter.servequake.com';
server.listen(PORT, INTERNAL_HOST, () => {
    console.log(`📡 Servidor de Node.js escuchando INTERNAMENTE en ${INTERNAL_HOST}:${PORT}`);
    console.log(`🌐 Acceso EXTERNO (APP) vía: ${PRODUCTION_API_URL}`);
});
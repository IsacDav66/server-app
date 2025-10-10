// Archivo: /server/api/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // <-- AÑADIDO

// La función principal exportada toma el pool y el JWT_SECRET
module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();
    
    // ----------------------------------------------------
    // RUTA DE REGISTRO (/api/auth/register) - CON JWT
    // ----------------------------------------------------
    router.post('/register', async (req, res) => {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Falta correo o contraseña.' });
        }

        try {
            // 1. Hash de la contraseña
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(password, salt);

            // 2. Insertar nuevo usuario
            const query = 'INSERT INTO usersapp (email, password_hash) VALUES ($1, $2) RETURNING id';
            const result = await pool.query(query, [email, passwordHash]);

            const userId = result.rows[0].id;
            
            // 3. Crear TOKEN para iniciar sesión automáticamente
            const token = jwt.sign({ userId: userId }, JWT_SECRET, { expiresIn: '30d' });

            // 4. Respuesta (Devuelve el token)
            res.status(201).json({ 
                success: true, 
                message: 'Usuario registrado con éxito e iniciado sesión.',
                userId: userId,
                token: token // <-- DEVOLVER EL TOKEN
            });

        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({ success: false, message: 'Ese correo ya está registrado.' });
            }
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });


    // ----------------------------------------------------
    // RUTA DE LOGIN (/api/auth/login) - CON JWT
    // ----------------------------------------------------
    router.post('/login', async (req, res) => {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Falta correo o contraseña.' });
        }

        try {
            // 1. Buscar usuario
            const query = 'SELECT id, password_hash FROM usersapp WHERE email = $1';
            const result = await pool.query(query, [email]);

            if (result.rows.length === 0) {
                return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
            }

            const user = result.rows[0];

            // 2. Comparar contraseña
            const isValidPassword = await bcrypt.compare(password, user.password_hash);

            if (!isValidPassword) {
                return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
            }

            // 3. CREAR TOKEN
            const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
            
            // 4. Respuesta de éxito (Devuelve el token)
            res.status(200).json({ 
                success: true, 
                message: 'Inicio de sesión exitoso.', 
                userId: user.id,
                token: token // <-- DEVOLVER EL TOKEN
            });

        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

   // ----------------------------------------------------
    // NUEVA RUTA: Subir Foto de Perfil (/api/user/upload-profile-pic)
    // ----------------------------------------------------
    router.post('/upload-profile-pic', 
        (req, res, next) => protect(req, res, next, JWT_SECRET), // 1. Verificar JWT
        uploadMiddleware, // 2. Subir el archivo con Multer
        async (req, res) => {
        
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No se subió ningún archivo.' });
        }
        
        const userId = req.user.userId;
        
        // 1. Obtener la ruta de acceso pública al archivo
        // NOTA: 'uploads' es la carpeta pública que Nginx/Express debe servir estáticamente
        const publicPath = `/uploads/${req.file.filename}`; 

        try {
            // 2. Guardar la ruta en la base de datos
            const query = 'UPDATE usersapp SET profile_pic_url = $1 WHERE id = $2';
            await pool.query(query, [publicPath, userId]);

            res.status(200).json({ 
                success: true, 
                message: 'Foto de perfil actualizada con éxito.',
                profilePicUrl: publicPath
            });

        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error al guardar la URL del perfil.' });
        }
    });

    return router;

};
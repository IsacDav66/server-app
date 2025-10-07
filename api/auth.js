const express = require('express');
const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken'); // !!! JWT ELIMINADO !!!

// La función principal exportada toma el pool de PostgreSQL
// Nota: Ya no necesita el JWT_SECRET
module.exports = (pool) => {
    const router = express.Router();
    
    // ----------------------------------------------------
    // RUTA DE REGISTRO (/api/auth/register)
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
            
            // 3. Crear sesión inmediatamente después del registro (para iniciar sesión automáticamente)
            req.session.userId = userId;

            // 4. Respuesta
            res.status(201).json({ 
                success: true, 
                message: 'Usuario registrado con éxito e iniciado sesión.',
                userId: userId
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
    // RUTA DE LOGIN (/api/auth/login) - CON SESIONES
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

            // 3. CREAR SESIÓN (Guarda la cookie de sesión)
            req.session.userId = user.id; // Guarda el ID en la sesión
            
            // 4. Respuesta de éxito (sin token)
            res.status(200).json({ 
                success: true, 
                message: 'Inicio de sesión exitoso.', 
                userId: user.id
            });

        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    return router;
};
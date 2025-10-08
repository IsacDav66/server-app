// Archivo: /server/middleware/auth.js

const jwt = require('jsonwebtoken'); // <-- AÑADIDO

/**
 * Middleware para proteger rutas basado en la verificación de un Token JWT.
 */
const protect = (req, res, next, JWT_SECRET) => { // <-- AHORA RECIBE JWT_SECRET
    
    // 1. Obtener el token de la cabecera "Authorization: Bearer <token>"
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ success: false, message: 'No autorizado. Token no encontrado.' });
    }

    try {
        // 2. Verificar el token
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // 3. Adjuntar el userId decodificado al objeto req
        req.user = { userId: decoded.userId }; 
        
        next(); // Token válido: Continúa
        
    } catch (error) {
        // Token inválido, expirado, etc.
        console.log('❌ Error de verificación de Token:', error.message);
        res.status(401).json({ 
            success: false, 
            message: 'No autorizado. Token inválido o expirado.' 
        });
    }
};

module.exports = { protect };
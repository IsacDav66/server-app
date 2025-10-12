// Archivo: /server/middleware/auth.js

const jwt = require('jsonwebtoken'); // <-- AÑADIDO


/**
 * Middleware ESTRICTO: Bloquea la ruta si no hay un token válido.
 */
const protect = (req, res, next, JWT_SECRET) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ success: false, message: 'No autorizado. Token no encontrado.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = { userId: decoded.userId }; 
        next();
    } catch (error) {
        res.status(401).json({ success: false, message: 'No autorizado. Token inválido.' });
    }
};

/**
 * Middleware SUAVE (NUEVO): Intenta decodificar el usuario si hay un token,
 * pero NUNCA bloquea la ruta. Ideal para rutas públicas con contenido personalizado.
 */
const softProtect = (req, res, next, JWT_SECRET) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = { userId: decoded.userId }; // Adjunta el usuario si el token es válido
        } catch (error) {
            // Si el token es inválido o expirado, simplemente no hacemos nada.
            req.user = null;
        }
    }
    
    next(); // Siempre continúa a la siguiente función
};


// Exportar ambos middlewares
module.exports = { protect, softProtect };
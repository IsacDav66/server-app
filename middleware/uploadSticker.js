// /server/middleware/uploadSticker.js
const multer = require('multer');
const path = require('path');

console.log('[Multer LOG] El middleware uploadSticker.js ha sido cargado.');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        console.log('[Multer LOG - destination] Se está determinando la carpeta de destino.');
        cb(null, path.join(__dirname, '../uploads/stickers_temp/'));
    },
    filename: function (req, file, cb) {
        console.log('[Multer LOG - filename] Generando nombre de archivo para:', file.originalname);
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    // --- ¡LOG DE DEPURACIÓN CLAVE! ---
    console.log('[Multer LOG - fileFilter] Revisando archivo:', {
        fieldname: file.fieldname,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size
    });

    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
        console.log('[Multer LOG - fileFilter] El archivo fue ACEPTADO.');
        cb(null, true);
    } else {
        console.log('[Multer LOG - fileFilter] ¡El archivo fue RECHAZADO!');
        // Creamos un nuevo error para que sea más fácil de rastrear
        const error = new Error('Tipo de archivo no soportado por el filtro.');
        error.code = 'INVALID_FILE_TYPE';
        cb(error, false);
    }
};

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: fileFilter
});

// Exportamos como una función para poder envolverlo en un try-catch
module.exports = (req, res, next) => {
    const uploader = upload.single('stickerFile');
    
    uploader(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            // Un error de Multer ocurrió (ej. archivo demasiado grande)
            console.error('[Multer LOG] Error de Multer:', err);
            return res.status(400).json({ success: false, message: `Error de subida: ${err.message}` });
        } else if (err) {
            // Un error personalizado (como el de nuestro fileFilter) u otro error inesperado
            console.error('[Multer LOG] Error inesperado durante la subida:', err);
            return res.status(400).json({ success: false, message: err.message });
        }
        
        // Si todo va bien, continuamos a la siguiente función en la ruta
        console.log('[Multer LOG] Middleware de subida completado sin errores. Pasando al siguiente manejador.');
        next();
    });
};
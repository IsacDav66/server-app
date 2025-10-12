// Archivo: /server/middleware/upload.js (ACTUALIZADO)

const multer = require('multer');

// 1. Usar almacenamiento en memoria en lugar de en disco
const storage = multer.memoryStorage();

// 2. Filtro de archivos (sin cambios)
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos de imagen.'), false);
    }
};

// 3. Inicializar Multer con la nueva configuración
const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 5 * 1024 * 1024 // Limite de 5MB
    },
    fileFilter: fileFilter
});

// Exporta el middleware (sin cambios)
module.exports = upload.single('profilePic');
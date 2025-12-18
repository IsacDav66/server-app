// /server/middleware/uploadPlayerCardCover.js
const multer = require('multer');

// Usamos almacenamiento en memoria para que sharp lo procese después
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos de imagen.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: fileFilter
});

// El frontend enviará el archivo con la clave 'coverImage'
module.exports = upload.single('coverImage');
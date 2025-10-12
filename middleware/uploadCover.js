// Archivo: /server/middleware/uploadCover.js

const multer = require('multer');

// Usar almacenamiento en memoria para que sharp pueda procesarlo después
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
    limits: { 
        fileSize: 10 * 1024 * 1024 // Limite de 10MB
    },
    fileFilter: fileFilter
});

// El campo 'coverPic' debe coincidir con el que enviaremos desde el frontend
module.exports = upload.single('coverPic');
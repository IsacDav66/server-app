const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const processImage = (type) => async (req, res, next) => {
    if (!req.file) return next();

    let folder = 'default';
    let size = 800; // Tamaño por defecto para posts/perfil

    if (type === 'profile') folder = 'profile_images';
    if (type === 'post') folder = 'post_images';
    if (type === 'cover') folder = 'cover_images'; 
    if (type === 'bio') folder = 'bio_images';
    if (type === 'card_cover') folder = 'card_cover_images';
    
    // --- NUEVO: TIPO EMOJI ---
    if (type === 'emoji') {
        folder = 'emojis';
        size = 128; // Los emojis son pequeñitos, ahorramos más espacio
    }
    
    const destinationPath = path.join(__dirname, `../uploads/${folder}/`);
    fs.mkdirSync(destinationPath, { recursive: true });

    const userId = req.user.adminTargetId || req.user.userId;
    const timestamp = Date.now();
    const newFilename = `${type}_${userId}_${timestamp}.webp`;
    const fullFilePath = path.join(destinationPath, newFilename);

    try {
        const pipeline = sharp(req.file.buffer, { animated: true });

        await pipeline
            .resize(size, size, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 70 }) // Calidad 70 es perfecta para miniaturas
            .toFile(fullFilePath);

        req.file.filename = newFilename;
        req.file.path = fullFilePath;
        req.file.destination = destinationPath;

        next();
    } catch (error) {
        console.error('❌ Error al procesar emoji con Sharp:', error);
        return res.status(500).json({ success: false, message: 'Error al procesar la imagen.' });
    }
};

module.exports = processImage;
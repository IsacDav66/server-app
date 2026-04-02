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
    // 🚀 AÑADE ESTO:
    if (type === 'group') {
        folder = 'group_photos';
        size = 500; // Tamaño optimizado para fotos de grupo
    }
    if (type === 'emoji') {
        folder = 'emojis';
        size = 128;
    }

    // --- NUEVO: TIPO BADGE (INSIGNIA) ---
    if (type === 'badge') {
        folder = 'badges';
        size = 128; // Tamaño optimizado para las insignias del perfil
    }
    
    const destinationPath = path.join(__dirname, `../uploads/${folder}/`);
    if (!fs.existsSync(destinationPath)) {
        fs.mkdirSync(destinationPath, { recursive: true });
    }

    const userId = req.user.adminTargetId || req.user.userId;
    const timestamp = Date.now();

    // Lógica para mantener la animación si es un GIF
    const isGif = req.file.mimetype === 'image/gif';
    const extension = isGif ? 'gif' : 'webp';
    
    const newFilename = `${type}_${userId}_${timestamp}.${extension}`;
    const fullFilePath = path.join(destinationPath, newFilename);

    try {
        // { animated: true } es vital para que los GIFs no se conviertan en una imagen estática
        const pipeline = sharp(req.file.buffer, { animated: true });

        pipeline.resize(size, size, { fit: 'inside', withoutEnlargement: true });

        if (isGif) {
            // Si es GIF, procesamos manteniendo el formato
            await pipeline.toFile(fullFilePath);
        } else {
            // Si es imagen normal (PNG/JPG), convertimos a WebP
            await pipeline.webp({ quality: 70 }).toFile(fullFilePath);
        }

        req.file.filename = newFilename;
        req.file.path = fullFilePath;
        req.file.destination = destinationPath;

        next();
    } catch (error) {
        console.error(`❌ Error al procesar ${type} con Sharp:`, error);
        return res.status(500).json({ success: false, message: 'Error al procesar la imagen.' });
    }
};

module.exports = processImage;
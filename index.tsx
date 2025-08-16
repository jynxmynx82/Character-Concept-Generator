/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from '@google/genai';
import JSZip from 'jszip';

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- CONFIGURATION ---
const STYLES = {
    'claymation': 'A charming claymation character made from plasticine. The image should have tangible textures, visible fingerprints, and soft lighting, evoking a classic stop-motion animation feel. Critically, avoid a smooth, digital 3D-rendered look.',
    'cyberpunk': 'A gritty cyberpunk portrait with subtle cybernetic enhancements. The scene is lit with dramatic, high-contrast neon lighting, casting deep shadows and creating a moody, futuristic atmosphere. The style should be painterly and textured, not photorealistic.',
    'b&w_photo': 'A classic black and white photograph with high contrast and medium film grain. The lighting is dramatic and directional, sculpting the features with light and shadow to create an emotional, iconic portrait. The final image must be monochrome.',
    'vintage_comic': 'A portrait in the style of 1970s American underground comix. The art must feature heavy, expressive, and thick black ink outlines. All shading and tones must be created using a combination of coarse, visible halftone dots (Ben-Day dots) and stark black ink cross-hatching. Use a limited, muted CMYK color palette, as if printed on cheap, off-white newsprint. The overall feeling should be graphic, gritty, and hand-drawn. CRITICAL: Absolutely no smooth digital gradients, airbrushing, or photorealistic rendering. The image must look like a scanned page from an old comic book.',
    'watercolor': 'A beautiful watercolor painting on textured paper. The style features soft, bleeding edges, pigment granulation, and bright highlights, capturing the authentic feel of a wet-on-wet watercolor technique. Avoid sharp, digital lines or a dry brush look.'
};
type StyleKey = keyof typeof STYLES;

const CHARACTER_VIEWS = [
    { name: 'Front View', prompt: 'Front view. The character is facing forward, looking directly into the camera. The head is not turned.' },
    { name: '3/4 View', prompt: 'Three-quarter view. The character\'s head is turned approximately 45 degrees away from the camera.' },
    { name: 'Profile View', prompt: 'Side-profile view. The camera is viewed from the side, looking directly sideways.' }
];

const MAX_GENERATION_RETRIES = 3;
const MAX_FILE_SIZE_MB = 4;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;


// --- HELPER FUNCTIONS ---
const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
    });
};

const generateRandomId = (length: number = 4): string => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};


// --- REACT COMPONENT ---
const App = () => {
    const [appState, setAppState] = useState<'upload' | 'loading' | 'results'>('upload');
    const [uploadedImage, setUploadedImage] = useState<{ file: File, previewUrl: string } | null>(null);
    const [selectedStyle, setSelectedStyle] = useState<StyleKey | null>(null);
    const [selectedRatio, setSelectedRatio] = useState<'16:9' | '9:16' | null>(null);
    const [selectedChroma, setSelectedChroma] = useState<'green' | 'blue' | null>(null);
    const [generatedImages, setGeneratedImages] = useState<{ src: string, label: string }[]>([]);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [error, setError] = useState<string | null>(null);

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (uploadedImage?.previewUrl) {
            URL.revokeObjectURL(uploadedImage.previewUrl);
        }

        const file = event.target.files?.[0];
        if (file) {
            if (file.size > MAX_FILE_SIZE_BYTES) {
                setError(`File is too large. Please upload an image under ${MAX_FILE_SIZE_MB}MB.`);
                setUploadedImage(null);
                event.target.value = ''; // Reset file input
                return;
            }
            const previewUrl = URL.createObjectURL(file);
            setUploadedImage({ file, previewUrl });
            setError(null);
        }
    };

    const handleGenerate = useCallback(async () => {
        if (!uploadedImage || !selectedStyle || !selectedRatio || !selectedChroma) return;

        setAppState('loading');
        setError(null);

        try {
            setLoadingMessage('Analyzing your character...');
            const imageBase64 = await fileToBase64(uploadedImage.file);

            const imagePart = {
                inlineData: {
                    data: imageBase64,
                    mimeType: uploadedImage.file.type,
                },
            };
            
            const descriptionPrompt = `Analyze the person in the source image, but generate a detailed, objective description focusing *only* on the features that would be visible in a headshot from the shoulders up. For example, do not describe their legs or shoes. Focus on key facial features (eye shape and color, nose structure, lip shape, jawline), skin tone, hair (color, texture, style), and any visible clothing. The description must be purely descriptive and objective, like a police sketch artist's notes, and should not exceed 150 words. Do not include any titles, headers, or conversational preamble. Output only the raw description of the person.`;
            
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ parts: [imagePart, { text: descriptionPrompt }] }],
            });
            
            const description = response.text;

            if (!description) {
                const blockReason = response.promptFeedback?.blockReason;
                if (blockReason) {
                    throw new Error(`Image analysis failed because the content was blocked (${blockReason}). Please try a different image.`);
                }
                throw new Error("Could not analyze the image; the model returned an empty description. Please try a different one.");
            }

            const results = [];
            for (const view of CHARACTER_VIEWS) {
                const stylePrompt = STYLES[selectedStyle];
                const backgroundPrompt = selectedChroma === 'green'
                    ? 'A solid, flat, evenly lit chroma key green background (#00ff00).'
                    : 'A solid, flat, evenly lit chroma key blue background (#0000ff).';

                const generateWithRetry = async (prompt: string): Promise<string> => {
                    let lastError: Error | null = null;
                    for (let attempt = 1; attempt <= MAX_GENERATION_RETRIES; attempt++) {
                        try {
                            setLoadingMessage(`Generating ${view.name} (${attempt}/${MAX_GENERATION_RETRIES})...`);
                            const imageGenResponse = await ai.models.generateImages({
                                model: 'imagen-3.0-generate-002',
                                prompt: prompt,
                                config: {
                                    numberOfImages: 1,
                                    outputMimeType: 'image/jpeg',
                                    aspectRatio: selectedRatio,
                                },
                            });
                            
                            if (imageGenResponse.generatedImages?.[0]?.image?.imageBytes) {
                                return imageGenResponse.generatedImages[0].image.imageBytes;
                            } else {
                                lastError = new Error("Model returned no image data.");
                            }
                        } catch (err: any) {
                            lastError = err;
                            console.error(`Attempt ${attempt} for ${view.name} failed:`, err);
                            if (attempt < MAX_GENERATION_RETRIES) {
                                await new Promise(resolve => setTimeout(resolve, 2000));
                            }
                        }
                    }
                    throw new Error(`Failed to generate '${view.name}' after ${MAX_GENERATION_RETRIES} attempts. Last error: ${lastError?.message}`);
                };
                
                const generationPrompt = `Generate an image with the following strict parameters:
1.  **Framing & Composition:** A close-up headshot, framing the character from the shoulders up. This is the most critical rule. The image MUST be framed this way.
2.  **Character Pose/Angle:** ${view.prompt}.
3.  **Art Style:** ${stylePrompt}.
4.  **Character Description:** ${description}.
5.  **Background:** ${backgroundPrompt}
6.  **Lighting:** The lighting on the subject should be neutral and clean.
7.  **Subject Count:** Exactly one person in the image.`.trim();
                
                const imageBytes = await generateWithRetry(generationPrompt);
                
                results.push({
                    src: `data:image/jpeg;base64,${imageBytes}`,
                    label: `${view.name} (${selectedStyle.replace(/_/g, ' ').replace(/(^\w{1})|(\s+\w{1})/g, letter => letter.toUpperCase())})`,
                });
            }
            
            setGeneratedImages(results);
            setAppState('results');

        } catch (err: any) {
            console.error(err);
            const errorMessage = err.message || 'An unexpected error occurred. Please try again.';
            setError(errorMessage);
            setAppState('upload');
        } finally {
            setLoadingMessage('');
        }
    }, [uploadedImage, selectedStyle, selectedRatio, selectedChroma]);
    
    const handleDownloadAll = useCallback(async () => {
        if (!uploadedImage || generatedImages.length === 0) return;

        const zip = new JSZip();
        const randomId = generateRandomId();
        
        // Add original image to the root
        const originalFileExtension = uploadedImage.file.name.split('.').pop() || 'jpg';
        zip.file(`original-${randomId}.${originalFileExtension}`, uploadedImage.file);
        
        generatedImages.forEach((img) => {
            const baseName = img.label.toLowerCase().replace(/[/\s()]/g, '-').replace(/--+/g, '-').replace(/^-+|-+$/g, '');
            const fileName = `${baseName}-${randomId}.jpeg`;
            
            const imageBase64 = img.src.split(',')[1];
            zip.file(fileName, imageBase64, { base64: true });
        });

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(zipBlob);
        link.download = `character-sheet-${randomId}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

    }, [uploadedImage, generatedImages]);

    const handleReset = () => {
        if (uploadedImage?.previewUrl) {
            URL.revokeObjectURL(uploadedImage.previewUrl);
        }
        setAppState('upload');
        setUploadedImage(null);
        setSelectedStyle(null);
        setSelectedRatio(null);
        setSelectedChroma(null);
        setGeneratedImages([]);
        setError(null);
    };

    const Subtitle = () => (
        <p className="subtitle">
            Upload a photo of a character, pick a style, and generate a new concept art sheet. For best results, start with a clear, well-lit headshot.
        </p>
    );

    return (
        <div className="app-container">
            {appState === 'upload' && (
                <div className="upload-screen">
                    <h1>Character Concept Generator</h1>
                    <Subtitle />
                     {error && <p className="error-message">{error}</p>}
                    <div className="dropzone" onClick={() => document.getElementById('file-input')?.click()}>
                        <input id="file-input" type="file" accept="image/*" onChange={handleFileChange} className="hidden" aria-label="Upload Image" />
                        <img id="image-preview" src={uploadedImage?.previewUrl} className={uploadedImage ? 'visible' : ''} alt={uploadedImage ? "Your uploaded preview" : ""}/>
                        {!uploadedImage && <p>Click or drag image to upload</p>}
                    </div>
                    {uploadedImage && (
                        <>
                            <h2>Choose a Style</h2>
                            <div className="style-selector">
                                {(Object.keys(STYLES) as StyleKey[]).map(styleKey => (
                                    <button 
                                        key={styleKey}
                                        className={`style-button ${selectedStyle === styleKey ? 'selected' : ''}`}
                                        onClick={() => setSelectedStyle(styleKey)}
                                    >
                                        {styleKey.replace(/_/g, ' ').replace(/(^\w{1})|(\s+\w{1})/g, letter => letter.toUpperCase())}
                                    </button>
                                ))}
                            </div>
                            {selectedStyle && (
                                <div className="style-description" key={selectedStyle}>
                                    {STYLES[selectedStyle]}
                                </div>
                            )}

                            <h2>Composition</h2>
                            <div className="composition-controls">
                                <div className="option-group">
                                    <label>Aspect Ratio</label>
                                    <div className="button-group">
                                        <button
                                            className={`option-button ${selectedRatio === '16:9' ? 'selected' : ''}`}
                                            onClick={() => setSelectedRatio('16:9')}
                                        >
                                            16:9
                                        </button>
                                        <button
                                            className={`option-button ${selectedRatio === '9:16' ? 'selected' : ''}`}
                                            onClick={() => setSelectedRatio('9:16')}
                                        >
                                            9:16
                                        </button>
                                    </div>
                                </div>
                                <div className="option-group">
                                    <label>Background</label>
                                    <div className="button-group">
                                        <button
                                            className={`option-button ${selectedChroma === 'green' ? 'selected' : ''}`}
                                            onClick={() => setSelectedChroma('green')}
                                        >
                                            Chroma Green
                                        </button>
                                        <button
                                            className={`option-button ${selectedChroma === 'blue' ? 'selected' : ''}`}
                                            onClick={() => setSelectedChroma('blue')}
                                        >
                                            Chroma Blue
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                    <button 
                        className="action-button"
                        onClick={handleGenerate} 
                        disabled={!uploadedImage || !selectedStyle || !selectedRatio || !selectedChroma}
                    >
                        Generate
                    </button>
                </div>
            )}

            {appState === 'loading' && (
                <div className="loading-screen">
                    <div className="spinner"></div>
                    <p className="loading-message">{loadingMessage}</p>
                </div>
            )}

            {appState === 'results' && (
                 <div className="results-screen">
                    <h1>Your Character Concept</h1>
                    <Subtitle />
                    <div className="results-grid">
                        <div className="result-item">
                            <div className="result-image-container">
                                <img src={uploadedImage!.previewUrl} alt="Original uploaded image" />
                            </div>
                            <div className="result-item-label">Original</div>
                        </div>
                        {generatedImages.map((img, index) => (
                            <div className="result-item generated-image" key={index}>
                                <div className="result-image-container">
                                    <img src={img.src} alt={img.label} />
                                </div>
                                <div className="result-item-label">{img.label}</div>
                            </div>
                        ))}
                    </div>
                    <div className="results-actions">
                        <button className="action-button" onClick={handleReset}>Create Another</button>
                        <button className="action-button secondary" onClick={handleDownloadAll}>Download All</button>
                    </div>
                </div>
            )}
        </div>
    );
};

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}
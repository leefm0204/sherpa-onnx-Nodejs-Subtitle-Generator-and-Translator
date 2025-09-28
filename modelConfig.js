import path from "path";
import sherpa_onnx from "sherpa-onnx-node";

// Default model configuration that can be reused
function createBaseModelConfig(modelSpecificConfig, tokensFile = "tokens.txt") {
  return (cfg) => {
    return new sherpa_onnx.OfflineRecognizer({
      featConfig: { sampleRate: cfg.sampleRate, featureDim: cfg.featDim },
      modelConfig: {
        ...modelSpecificConfig(cfg),
        tokens: path.join(cfg.modelDir, tokensFile),
        numThreads: 2, // Reduced from 4 to 2 threads to decrease CPU usage and prevent speed degradation
        provider: "cpu",
        debug: false,
      },
    });
  };
}

const MODELS = {
  senseVoice: {
    modelDir: "./models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    createRecognizer: createBaseModelConfig(
      (cfg) => ({
        senseVoice: {
          model: path.join(cfg.modelDir, "model.int8.onnx"),
          useInverseTextNormalization: 1,
        }
      })
    ),
  },

  nemoCtc: {
    modelDir:
      "./models/sherpa-onnx-nemo-fast-conformer-transducer-be-de-en-es-fr-hr-it-pl-ru-uk-20k",
    createRecognizer: createBaseModelConfig(
      (cfg) => ({
        nemoCtc: {
          model: path.join(cfg.modelDir, "model.onnx"),
          useInverseTextNormalization: 1,
        }
      })
    ),
  },

  transducer: {
    modelDir: "./models/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01",
    createRecognizer: createBaseModelConfig(
      (cfg) => ({
        transducer: {
          encoder: path.join(
            cfg.modelDir,
            "encoder-epoch-99-avg-1.int8.onnx",
          ),
          decoder: path.join(
            cfg.modelDir,
            "decoder-epoch-99-avg-1.int8.onnx",
          ),
          joiner: path.join(cfg.modelDir, "joiner-epoch-99-avg-1.int8.onnx"),
          useInverseTextNormalization: 1,
        }
      })
    ),
  },
};

export function getModel(modelName) {
  const m = MODELS[modelName];
  if (!m) {
    const avail = Object.keys(MODELS).join(", ");
    throw new Error(`Unknown model "${modelName}". Available: ${avail}`);
  }
  return m;
}

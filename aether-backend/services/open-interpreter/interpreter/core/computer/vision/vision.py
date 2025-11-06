import base64
import contextlib
import io
import os
import tempfile

from PIL import Image

from ...utils.lazy_import import lazy_import
from ..utils.computer_vision import pytesseract_get_text

# transformers = lazy_import("transformers") # Doesn't work for some reason! We import it later.

# Import config loader for InternVL configuration
try:
    from pathlib import Path
    config_path = Path(__file__).parent.parent.parent.parent.parent.parent / "backend" / "config_loader.py"
    if config_path.exists():
        import importlib.util
        spec = importlib.util.spec_from_file_location("config_loader", config_path)
        config_loader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(config_loader)
        load_config = config_loader.load_config
    else:
        def load_config():
            return {
                "MODELS": {
                    "vision_model": "internvl2-2b",  # Default to InternVL 2B
                    "primary_chat_model": "qwen/qwen3-4b-2507",
                    "fallback_chat_model": "qwen/qwen3-14b"
                },
                "PROVIDERS": {
                    "lm_studio_url": "http://localhost:1234/v1",
                    "lm_studio_api_key": "not-needed"
                }
            }
except Exception:
    def load_config():
        return {
            "MODELS": {
                "vision_model": "internvl2-2b",  # Default to InternVL 2B
                "primary_chat_model": "qwen/qwen3-4b-2507",
                "fallback_chat_model": "qwen/qwen3-14b"
            },
            "PROVIDERS": {
                "lm_studio_url": "http://localhost:1234/v1",
                "lm_studio_api_key": "not-needed"
            }
        }


class Vision:
    def __init__(self, computer):
        self.computer = computer
        self.model = None  # Will load upon first use
        self.tokenizer = None  # Will load upon first use
        self.processor = None  # For InternVL
        self.easyocr = None
        # Load vision model configuration
        config = load_config()
        self.vision_model = config["MODELS"].get("vision_model", "internvl2-2b")
        self.lm_studio_url = config["PROVIDERS"].get("lm_studio_url", "http://localhost:1234/v1")

    def load(self, load_vision_model=True, load_easyocr=True):
        # print("Loading vision models...")

        with contextlib.redirect_stdout(
            open(os.devnull, "w")
        ), contextlib.redirect_stderr(open(os.devnull, "w")):
            if self.easyocr == None and load_easyocr:
                import easyocr

                self.easyocr = easyocr.Reader(
                    ["en"]
                )  # this needs to run only once to load the model into memory

            if load_vision_model:
                if self.vision_model == "internvl2-2b" and self.model is None:
                    # Use InternVL 2B via LM Studio
                    if self.computer.debug:
                        print(
                            "Open Interpreter will use InternVL 2B via LM Studio for image processing."
                        )
                    # InternVL 2B will be handled via LM Studio API calls, no local loading needed
                    return True

                elif self.vision_model == "moondream" and self.model is None:
                    # Original Moondream loading
                    import transformers  # Wait until we use it. Transformers can't be lazy loaded for some reason!

                    os.environ["TOKENIZERS_PARALLELISM"] = "false"

                    if self.computer.debug:
                        print(
                            "Open Interpreter will use Moondream (tiny vision model) to describe images to the language model. Set `interpreter.llm.vision_renderer = None` to disable this behavior."
                        )
                        print(
                            "Alternatively, you can use a vision-supporting LLM and set `interpreter.llm.supports_vision = True`."
                        )
                    model_id = "vikhyatk/moondream2"
                    revision = "2024-04-02"
                    print("Loading Moondream model...")

                    self.model = transformers.AutoModelForCausalLM.from_pretrained(
                        model_id, trust_remote_code=True, revision=revision
                    )
                    self.tokenizer = transformers.AutoTokenizer.from_pretrained(
                        model_id, revision=revision
                    )
                    return True
                elif self.model is None:
                    # Default fallback to Moondream
                    if self.computer.debug:
                        print(f"Unknown vision model '{self.vision_model}', falling back to Moondream.")
                    self.vision_model = "moondream"
                    return self.load(load_vision_model=True, load_easyocr=False)

    def ocr(
        self,
        base_64=None,
        path=None,
        lmc=None,
        pil_image=None,
    ):
        """
        Gets OCR of image.
        """

        if lmc:
            if "base64" in lmc["format"]:
                # # Extract the extension from the format, default to 'png' if not specified
                # if "." in lmc["format"]:
                #     extension = lmc["format"].split(".")[-1]
                # else:
                #     extension = "png"
                # Save the base64 content as a temporary file
                img_data = base64.b64decode(lmc["content"])
                with tempfile.NamedTemporaryFile(
                    delete=False, suffix=".png"
                ) as temp_file:
                    temp_file.write(img_data)
                    temp_file_path = temp_file.name

                # Set path to the path of the temporary file
                path = temp_file_path

            elif lmc["format"] == "path":
                # Convert to base64
                path = lmc["content"]
        elif base_64:
            # Save the base64 content as a temporary file
            img_data = base64.b64decode(base_64)
            with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as temp_file:
                temp_file.write(img_data)
                temp_file_path = temp_file.name

            # Set path to the path of the temporary file
            path = temp_file_path
        elif path:
            pass
        elif pil_image:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as temp_file:
                pil_image.save(temp_file, format="PNG")
                temp_file_path = temp_file.name

            # Set path to the path of the temporary file
            path = temp_file_path

        try:
            if not self.easyocr:
                self.load(load_moondream=False)
            result = self.easyocr.readtext(path)
            text = " ".join([item[1] for item in result])
            return text.strip()
        except ImportError:
            print(
                "\nTo use local vision, run `pip install 'open-interpreter[local]'`.\n"
            )
            return ""

    def query(
        self,
        query="Describe this image. Also tell me what text is in the image, if any.",
        base_64=None,
        path=None,
        lmc=None,
        pil_image=None,
    ):
        """
        Uses vision model to ask query of the image (which can be a base64, path, or lmc message)
        Supports both InternVL 2B via LM Studio and local Moondream
        """

        # Handle InternVL 2B via LM Studio
        if self.vision_model == "internvl2-2b":
            return self._query_internvl_via_lm_studio(query, base_64, path, lmc, pil_image)

        # Handle local Moondream
        if self.model == None and self.tokenizer == None:
            try:
                success = self.load(load_easyocr=False)
            except ImportError:
                print(
                    "\nTo use local vision, run `pip install 'open-interpreter[local]'`.\n"
                )
                return ""
            if not success:
                return ""

        if lmc:
            if "base64" in lmc["format"]:
                # Decode the base64 image
                img_data = base64.b64decode(lmc["content"])
                img = Image.open(io.BytesIO(img_data))

            elif lmc["format"] == "path":
                # Convert to base64
                image_path = lmc["content"]
                img = Image.open(image_path)
        elif base_64:
            img_data = base64.b64decode(base_64)
            img = Image.open(io.BytesIO(img_data))
        elif path:
            img = Image.open(path)
        elif pil_image:
            img = pil_image

        with contextlib.redirect_stdout(open(os.devnull, "w")):
            enc_image = self.model.encode_image(img)
            answer = self.model.answer_question(
                enc_image, query, self.tokenizer, max_length=400
            )

        return answer

    def _query_internvl_via_lm_studio(self, query, base_64=None, path=None, lmc=None, pil_image=None):
        """
        Query InternVL 2B model via LM Studio API
        """
        try:
            import requests
        except ImportError:
            print("Requests library not available for LM Studio API calls")
            return ""

        # Prepare image data
        image_data = None
        if lmc:
            if "base64" in lmc["format"]:
                image_data = lmc["content"]
            elif lmc["format"] == "path":
                # Convert path to base64
                with open(lmc["content"], "rb") as f:
                    image_data = base64.b64encode(f.read()).decode('utf-8')
        elif base_64:
            image_data = base_64
        elif path:
            with open(path, "rb") as f:
                image_data = base64.b64encode(f.read()).decode('utf-8')
        elif pil_image:
            # Convert PIL image to base64
            buffer = io.BytesIO()
            pil_image.save(buffer, format="PNG")
            image_data = base64.b64encode(buffer.getvalue()).decode('utf-8')

        if not image_data:
            return "No image data provided"

        # Prepare the request for LM Studio
        url = f"{self.lm_studio_url}/chat/completions"
        headers = {
            "Content-Type": "application/json"
        }

        # Create messages for vision model
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": query},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{image_data}"
                        }
                    }
                ]
            }
        ]

        payload = {
            "model": "internvl2-2b",  # This should match the model loaded in LM Studio
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": 400
        }

        try:
            response = requests.post(url, json=payload, headers=headers, timeout=30)
            if response.status_code == 200:
                result = response.json()
                if "choices" in result and len(result["choices"]) > 0:
                    return result["choices"][0]["message"]["content"]
                else:
                    return "No response from vision model"
            else:
                if self.computer.debug:
                    print(f"LM Studio API error: {response.status_code} - {response.text}")
                return f"Vision API error: {response.status_code}"
        except Exception as e:
            if self.computer.debug:
                print(f"Error calling LM Studio vision API: {str(e)}")
            return f"Error processing image: {str(e)}"

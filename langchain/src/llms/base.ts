import { InMemoryCache } from "../cache/index.js";
import { BaseCache, BasePromptValue, LLMResult } from "../schema/index.js";
import {
  BaseLanguageModel,
  BaseLanguageModelParams,
} from "../base_language/index.js";
import {
  CallbackManager,
  CallbackManagerForLLMRun,
} from "../callbacks/manager.js";
import { BaseCallbackHandler } from "../callbacks/index.js";

export type SerializedLLM = {
  _model: string;
  _type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;

export interface BaseLLMParams extends BaseLanguageModelParams {
  /**
   * @deprecated Use `maxConcurrency` instead
   */
  concurrency?: number;
  cache?: BaseCache | boolean;
}

/**
 * LLM Wrapper. Provides an {@link call} (an {@link generate}) function that takes in a prompt (or prompts) and returns a string.
 */
export abstract class BaseLLM extends BaseLanguageModel {
  /**
   * The name of the LLM class
   */
  name: string;

  cache?: BaseCache;

  constructor({ cache, concurrency, ...rest }: BaseLLMParams) {
    super(concurrency ? { maxConcurrency: concurrency, ...rest } : rest);
    if (typeof cache === "object") {
      this.cache = cache;
    } else if (cache) {
      this.cache = InMemoryCache.global();
    } else {
      this.cache = undefined;
    }
  }

  async generatePrompt(
    promptValues: BasePromptValue[],
    stop?: string[],
    callbacks?: CallbackManager | BaseCallbackHandler[]
  ): Promise<LLMResult> {
    const prompts: string[] = promptValues.map((promptValue) =>
      promptValue.toString()
    );
    return this.generate(prompts, stop, callbacks);
  }

  /**
   * Run the LLM on the given prompts and input.
   */
  abstract _generate(
    prompts: string[],
    stop?: string[],
    runManager?: CallbackManagerForLLMRun
  ): Promise<LLMResult>;

  /** @ignore */
  async _generateUncached(
    prompts: string[],
    stop?: string[],
    callbacks?: CallbackManager | BaseCallbackHandler[]
  ): Promise<LLMResult> {
    const callbackManager_ = await CallbackManager.configure(
      callbacks,
      Array.isArray(this.callbacks) ? this.callbacks : this.callbacks?.handlers,
      { verbose: this.verbose }
    );
    const runManager = await callbackManager_?.handleLLMStart(
      { name: this._llmType() },
      prompts
    );
    let output;
    try {
      output = await this._generate(prompts, stop, runManager);
    } catch (err) {
      await runManager?.handleLLMError(err);
      throw err;
    }

    await runManager?.handleLLMEnd(output);
    output.__run = runManager ? { runId: runManager?.runId } : undefined;
    return output;
  }

  /**
   * Run the LLM on the given propmts an input, handling caching.
   */
  async generate(
    prompts: string[],
    stop?: string[],
    callbacks?: CallbackManager | BaseCallbackHandler[]
  ): Promise<LLMResult> {
    if (!Array.isArray(prompts)) {
      throw new Error("Argument 'prompts' is expected to be a string[]");
    }

    if (!this.cache) {
      return this._generateUncached(prompts, stop, callbacks);
    }

    const { cache } = this;
    const params = this.serialize();
    params.stop = stop;

    const llmStringKey = `${Object.entries(params).sort()}`;
    const missingPromptIndices: number[] = [];
    const generations = await Promise.all(
      prompts.map(async (prompt, index) => {
        const result = await cache.lookup(prompt, llmStringKey);
        if (!result) {
          missingPromptIndices.push(index);
        }
        return result;
      })
    );

    let llmOutput = {};
    if (missingPromptIndices.length > 0) {
      const results = await this._generateUncached(
        missingPromptIndices.map((i) => prompts[i]),
        stop,
        callbacks
      );
      await Promise.all(
        results.generations.map(async (generation, index) => {
          const promptIndex = missingPromptIndices[index];
          generations[promptIndex] = generation;
          return cache.update(prompts[promptIndex], llmStringKey, generation);
        })
      );
      llmOutput = results.llmOutput ?? {};
    }

    return { generations, llmOutput } as LLMResult;
  }

  /**
   * Convenience wrapper for {@link generate} that takes in a single string prompt and returns a single string output.
   */
  async call(
    prompt: string,
    stop?: string[],
    callbacks?: CallbackManager | BaseCallbackHandler[]
  ) {
    const { generations } = await this.generate([prompt], stop, callbacks);
    return generations[0][0].text;
  }

  /**
   * Get the identifying parameters of the LLM.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _identifyingParams(): Record<string, any> {
    return {};
  }

  /**
   * Return the string type key uniquely identifying this class of LLM.
   */
  abstract _llmType(): string;

  /**
   * Return a json-like object representing this LLM.
   */
  serialize(): SerializedLLM {
    return {
      ...this._identifyingParams(),
      _type: this._llmType(),
      _model: this._modelType(),
    };
  }

  _modelType(): string {
    return "base_llm" as const;
  }

  /**
   * Load an LLM from a json-like object describing it.
   */
  static async deserialize(data: SerializedLLM): Promise<BaseLLM> {
    const { _type, _model, ...rest } = data;
    if (_model && _model !== "base_llm") {
      throw new Error(`Cannot load LLM with model ${_model}`);
    }
    const Cls = {
      openai: (await import("./openai.js")).OpenAI,
    }[_type];
    if (Cls === undefined) {
      throw new Error(`Cannot load  LLM with type ${_type}`);
    }
    return new Cls(rest);
  }
}

/**
 * LLM class that provides a simpler interface to subclass than {@link BaseLLM}.
 *
 * Requires only implementing a simpler {@link _call} method instead of {@link _generate}.
 *
 * @augments BaseLLM
 */
export abstract class LLM extends BaseLLM {
  /**
   * Run the LLM on the given prompt and input.
   */
  abstract _call(
    prompt: string,
    stop?: string[],
    runManager?: CallbackManagerForLLMRun
  ): Promise<string>;

  async _generate(
    prompts: string[],
    stop?: string[],
    runManager?: CallbackManagerForLLMRun
  ): Promise<LLMResult> {
    const generations = [];
    for (let i = 0; i < prompts.length; i += 1) {
      const text = await this._call(prompts[i], stop, runManager);
      generations.push([{ text }]);
    }
    return { generations };
  }
}

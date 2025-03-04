import { isNode, ZrNodeKind } from "../Ast/Nodes";
import { getFriendlyName } from "../Ast/Nodes/Functions";
import {
	ArrayIndexExpression,
	ArrayLiteralExpression,
	BinaryExpression,
	SourceFile,
	CallExpression,
	SimpleCallExpression,
	ForInStatement,
	FunctionDeclaration,
	IfStatement,
	Node,
	ObjectLiteral,
	PropertyAccessExpression,
	SourceBlock,
	VariableDeclaration,
	OptionExpression,
	FunctionExpression,
	Identifier,
	EnumDeclarationStatement,
} from "../Ast/Nodes/NodeTypes";
import ZrObject from "../Data/Object";
import ZrLocalStack, { StackValueAssignmentError, ZrValue } from "../Data/Locals";
import { isArray, isMap } from "../Util";
import ZrUserFunction from "../Data/UserFunction";
import ZrLuauFunction from "../Data/LuauFunction";
import ZrContext from "../Data/Context";
import { types } from "../Ast";
import { InferUserdataKeys, ZrInstanceUserdata, ZrUserdata } from "../Data/Userdata";
import ZrUndefined from "../Data/Undefined";
import { ZrInputStream, ZrOutputStream } from "../Data/Stream";
import { ZrNodeFlag } from "Ast/Nodes/Enum";
import ZrRange from "Data/Range";
import { ZrEnum } from "Data/Enum";
import { ZrEnumItem } from "Data/EnumItem";
import { $print } from "rbxts-transform-debug";

export enum ZrRuntimeErrorCode {
	NodeValueError,
	EvaluationError,
	StackOverflow,
	InvalidForInExpression,
	IndexingUndefined,
	InvalidArrayIndex,
	InvalidType,
	NotCallable,
	InvalidPropertyAccess,
	PipeError,
	InstanceSetViolation,
	InstanceGetViolation,
	InvalidIterator,
	ReassignConstant,
	InvalidRangeError,
	InvalidEnumItem,
	OutOfRange,
	UnassignedVariable,
}
export interface ZrRuntimeError {
	message: string;
	code: ZrRuntimeErrorCode;
	node?: Node;
}

const getTypeName = (value: ZrValue | ZrUndefined) => {
	if (isArray(value)) {
		return "Array";
	} else if (value instanceof ZrObject) {
		return "Object";
	} else if (value === ZrUndefined) {
		return "undefined";
	} else {
		return typeOf(value);
	}
};

/**
 * Handles a block
 */
export default class ZrRuntime {
	private level = 0;
	private errors = new Array<ZrRuntimeError>();
	private functions = new Map<string, ZrLuauFunction>();
	private context: ZrContext;
	public constructor(
		private source: SourceFile | SourceBlock,
		private locals = new ZrLocalStack(),
		private executingPlayer?: Player,
	) {
		this.context = new ZrContext(this);
	}

	private runtimeError(message: string, code: ZrRuntimeErrorCode, node?: Node): never {
		const err = identity<ZrRuntimeError>({
			message,
			code,
			node,
		});
		this.errors.push(err);
		throw `[RuntimeError] ${err.message}`;
	}

	private runtimeAssert(
		condition: unknown,
		message: string,
		code: ZrRuntimeErrorCode,
		node?: Node,
	): asserts condition {
		if (condition === false) {
			this.runtimeError(message, code, node);
		}
	}

	private runtimeAssertNotUndefined(
		condition: unknown,
		message: string,
		code: ZrRuntimeErrorCode,
		node?: Node,
	): asserts condition is defined {
		if (condition === undefined) {
			this.runtimeError(message, code, node);
		}
	}

	public registerFunction(name: string, func: ZrLuauFunction) {
		this.functions.set(name, func);
		this.locals.setGlobal(name, func);
	}

	public getLocals() {
		return this.locals;
	}

	public getErrors() {
		return this.errors;
	}

	/**
	 * Pushes a new stack onto the executor
	 */
	private push() {
		this.level++;
		this.locals.push();

		if (this.level > 4096) {
			this.runtimeError("Stack overflow", ZrRuntimeErrorCode.StackOverflow);
		}
	}

	/**
	 * Pops the last stack from the executor
	 */
	private pop() {
		this.level--;
		return this.locals.pop();
	}

	private executeSetVariable(node: VariableDeclaration) {
		const { identifier, expression, flags } = node;
		const value = this.evaluateNode(expression);
		if (types.isIdentifier(identifier)) {
			const isConstant = (flags & ZrNodeFlag.Const) !== 0;
			const isLocalAssignment = isConstant || (flags & ZrNodeFlag.Let) !== 0;

			if (isLocalAssignment) {
				this.getLocals().setLocal(identifier.name, value === ZrUndefined ? undefined : value, isConstant);
			} else {
				const result = this.getLocals().setUpValueOrLocal(
					identifier.name,
					value === ZrUndefined ? undefined : value,
					isConstant,
				);
				if (result.isErr()) {
					const { errValue } = result;
					if (errValue === StackValueAssignmentError.ReassignConstant) {
						this.runtimeError(
							`Unable to reassign constant or readonly '${identifier.name}'`,
							ZrRuntimeErrorCode.ReassignConstant,
							node,
						);
					}
				}
			}
		} else {
			this.runtimeError("Not yet implemented", ZrRuntimeErrorCode.EvaluationError); // TODO implement
		}

		return undefined;
	}

	private evaluateObjectNode(node: ObjectLiteral) {
		const object = new ZrObject();
		for (const prop of node.values) {
			const value = this.evaluateNode(prop.initializer);
			this.runtimeAssertNotUndefined(value, "No value", ZrRuntimeErrorCode.NodeValueError, prop.initializer);
			object.set(prop.name.name, value);
		}
		return object;
	}

	private evaluateFunctionDeclaration(node: FunctionDeclaration) {
		const declaration = new ZrUserFunction(node);
		this.locals.setLocal(node.name.name, declaration, true);
		return declaration;
	}

	private evaluateEnumDeclaration(node: EnumDeclarationStatement) {
		const name = node.name.name;

		const declaration = ZrEnum.fromArray(
			node.name.name,
			node.values.map((v) => v.name.name),
		);

		$print(declaration.getItems(), "declaration");
		this.locals.setLocal(name, declaration, true);
		return declaration;
	}

	private evaluateFunctionExpression(node: FunctionExpression) {
		const declaration = new ZrUserFunction(node);
		return declaration;
	}

	private evaluateArrayNode(node: ArrayLiteralExpression) {
		const values = new Array<ZrValue>();
		let i = 0;
		for (const subNode of node.values) {
			const value = this.evaluateNode(subNode);
			this.runtimeAssertNotUndefined(
				value,
				"Array value is NONE at index " + i,
				ZrRuntimeErrorCode.NodeValueError,
				subNode,
			);
			if (value === ZrUndefined) {
				break;
			}
			values.push(value);
			i++;
		}
		return values;
	}

	private evaluateIfStatement(node: IfStatement) {
		const { condition, thenStatement, elseStatement } = node;
		assert(condition);
		const resultOfCondition = this.evaluateNode(condition);
		this.runtimeAssertNotUndefined(
			condition,
			"Condition not valid?",
			ZrRuntimeErrorCode.EvaluationError,
			condition,
		);

		const isTruthy =
			resultOfCondition !== undefined && resultOfCondition !== false && resultOfCondition !== ZrUndefined;

		if (isTruthy && thenStatement !== undefined) {
			this.evaluateNode(thenStatement);
		} else if (elseStatement !== undefined) {
			this.evaluateNode(elseStatement);
		}
	}

	private evaluateForInStatement(node: ForInStatement) {
		const { initializer, statement } = node;
		let { expression } = node;

		// Shortcut a parenthesized expression
		if (isNode(expression, ZrNodeKind.ParenthesizedExpression)) {
			expression = expression.expression;
		}

		let value: ZrValue | ZrUndefined | undefined;

		if (isNode(expression, ZrNodeKind.Identifier)) {
			value = this.locals.getLocalOrUpValue(expression.name)?.[0] ?? ZrUndefined;
		} else if (
			types.isCallableExpression(expression) ||
			isNode(expression, ZrNodeKind.ArrayLiteralExpression) ||
			isNode(expression, ZrNodeKind.ObjectLiteralExpression) ||
			isNode(expression, ZrNodeKind.BinaryExpression)
		) {
			value = this.evaluateNode(expression);
		} else {
			this.runtimeError(
				"Invalid expression to ForIn statement - expects Array or Object",
				ZrRuntimeErrorCode.InvalidForInExpression,
				expression,
			);
		}

		if (value === ZrUndefined) {
			this.runtimeError("Cannot iterate undefined value", ZrRuntimeErrorCode.InvalidIterator, expression);
		}

		this.runtimeAssertNotUndefined(
			value,
			"Expression expected",
			ZrRuntimeErrorCode.InvalidForInExpression,
			expression,
		);
		this.runtimeAssert(
			isArray(value) || value instanceof ZrObject || value instanceof ZrRange,
			"Array, Map or Object expected",
			ZrRuntimeErrorCode.InvalidType,
			expression,
		);
		if (value instanceof ZrObject) {
			for (const [k, v] of value.toMap()) {
				this.push();
				this.locals.setLocal(initializer.name, [k, v]);
				this.evaluateNode(statement);
				this.pop();
			}
		} else if (value instanceof ZrRange) {
			for (const item of value.Iterator()) {
				this.push();
				this.locals.setLocal(initializer.name, item);
				this.evaluateNode(statement);
				this.pop();
			}
		} else {
			for (const [, v] of pairs(value)) {
				this.push();
				this.locals.setLocal(initializer.name, v);
				this.evaluateNode(statement);
				this.pop();
			}
		}
	}

	private evaluateArrayIndexExpression(node: ArrayIndexExpression) {
		const { expression, index } = node;
		const value = this.evaluateNode(expression);

		if (value instanceof ZrEnum) {
			const enumValue = value.getItemByIndex(index.value);
			if (!enumValue) {
				this.runtimeAssertNotUndefined(
					value,
					"Index out of range for enum " + index.value,
					ZrRuntimeErrorCode.OutOfRange,
					expression,
				);
			}
			return enumValue;
		} else {
			this.runtimeAssertNotUndefined(
				value,
				"Attempted to index nil value",
				ZrRuntimeErrorCode.IndexingUndefined,
				expression,
			);
			this.runtimeAssert(
				isArray<ZrValue>(value),
				"Attempt to index " + getTypeName(value) + " with a number",
				ZrRuntimeErrorCode.InvalidArrayIndex,
				index,
			);
			return value[index.value];
		}
	}

	private setUserdata(
		expression: PropertyAccessExpression["expression"],
		userdata: ZrUserdata<defined>,
		key: string,
		value: ZrValue,
	) {
		if (userdata.isInstance()) {
			this.runtimeError(
				"Runtime Violation: Instance properties are read-only via Zirconium",
				ZrRuntimeErrorCode.InstanceSetViolation,
				expression,
			);
		} else {
			const object = userdata.value() as Record<string, unknown>;
			try {
				object[key] = value;
			} catch (err) {
				this.runtimeError(tostring(err), ZrRuntimeErrorCode.InstanceSetViolation, expression);
			}
		}
	}

	private getUserdata<T extends ZrUserdata<defined>>(
		expression: PropertyAccessExpression["expression"],
		userdata: T,
		key: string,
	) {
		if (userdata.isInstance()) {
			try {
				return userdata.get(key as InferUserdataKeys<T>);
			} catch (err) {
				this.runtimeError(tostring(err), ZrRuntimeErrorCode.InstanceGetViolation, expression);
			}
		} else {
			const object = userdata.value() as Record<string, ZrValue>;
			return object[key];
		}
	}

	private evaluatePropertyAccessExpression(node: PropertyAccessExpression) {
		const { expression, name } = node;
		const value = this.evaluateNode(expression);
		const id = name.name;
		this.runtimeAssertNotUndefined(id, "", ZrRuntimeErrorCode.NodeValueError, name);
		this.runtimeAssertNotUndefined(
			value,
			"Attempted to index nil with " + id,
			ZrRuntimeErrorCode.IndexingUndefined,
			expression,
		);
		if (value instanceof ZrObject) {
			return value.get(id);
		} else if (value instanceof ZrUserdata) {
			return this.getUserdata(expression, value, id);
		} else if (value instanceof ZrEnum) {
			return (
				value.getItemByName(id) ??
				this.runtimeError(`${id} is not a valid enum item`, ZrRuntimeErrorCode.InvalidEnumItem, name)
			);
		} else if (value instanceof ZrEnumItem) {
			if (id === "name") {
				return value.getName();
			} else if (id === "value") {
				return value.getValue();
			} else {
				this.runtimeError(
					`Attempted to index EnumItem with ${id}`,
					ZrRuntimeErrorCode.InvalidPropertyAccess,
					name,
				);
			}
		} else if (isMap<ZrValue>(value)) {
			return value.get(id);
		} else if (value instanceof ZrRange) {
			const property = ZrRange.properties[id];
			if (property !== undefined) {
				return property(value);
			} else {
				this.runtimeError(
					`${id} is not a valid member of Range`,
					ZrRuntimeErrorCode.InvalidPropertyAccess,
					name,
				);
			}
		} else {
			this.runtimeError(
				`Attempt to index ${getTypeName(value)} with '${id}'`,
				ZrRuntimeErrorCode.InvalidPropertyAccess,
				name,
			);
		}
	}

	private evaluateFunctionCall(node: CallExpression | SimpleCallExpression, context: ZrContext) {
		const { expression, children, arguments: callArgs } = node;

		let options = new Array<OptionExpression>();
		if (types.isCallExpression(node)) {
			({ options } = node);
		}

		let matching: ZrValue | ZrUndefined | undefined;
		if (types.isArrayIndexExpression(expression)) {
			throw `Not supported yet`;
		} else if (types.isPropertyAccessExpression(expression)) {
			matching = this.evaluateNode(expression);
		} else {
			matching = this.locals.getLocalOrUpValue(expression.name)?.[0];
		}

		// const matching = this.locals.getLocalOrUpValue(name)?.[0];
		if (matching instanceof ZrUserFunction) {
			this.push();
			const params = matching.getParameters();
			for (let i = 0; i < params.size(); i++) {
				const param = params[i];
				const value = callArgs[i];
				if (value !== undefined) {
					const nodeValue = this.evaluateNode(value);
					this.runtimeAssertNotUndefined(nodeValue, "Huh?", ZrRuntimeErrorCode.EvaluationError, node);

					if (nodeValue !== ZrUndefined) {
						this.locals.setLocal(param.name.name, nodeValue);
					}
				}
			}
			for (const option of options) {
				const value = this.evaluateNode(option.expression);
				if (value !== undefined && value !== ZrUndefined) {
					this.locals.setLocal(option.option.flag, value);
				}
			}

			this.evaluateNode(matching.getBody());
			this.pop();
		} else if (matching instanceof ZrLuauFunction) {
			const args = new Array<ZrValue | ZrUndefined>();
			let i = 0;
			for (const child of callArgs) {
				const value = this.evaluateNode(child);
				if (value !== undefined) {
					args[i] = value;
				}
				i++;
			}
			const result = matching.call(context, ...args);
			if (result !== undefined) {
				return result;
			}
		} else {
			this.runtimeError(
				this.getFullName(expression) + " is not a function",
				ZrRuntimeErrorCode.NotCallable,
				node,
			);
		}
	}

	public getLeafName(id: PropertyAccessExpression | ArrayIndexExpression | Identifier): string {
		if (types.isIdentifier(id)) {
			return id.name;
		} else if (types.isPropertyAccessExpression(id)) {
			return id.name.name;
		} else {
			return tostring(id.index.value);
		}
	}

	public getFullName(id: PropertyAccessExpression | ArrayIndexExpression | Identifier): string {
		if (types.isIdentifier(id)) {
			return id.name;
		} else if (types.isArrayIndexExpression(id)) {
			return `${this.getFullName(id.expression)}[${id.index.value}]`;
		} else if (types.isPropertyAccessExpression(id)) {
			return `${this.getFullName(id.expression)}.${this.getFullName(id.name)}`;
		} else {
			return "?";
		}
	}

	public evaluateBinaryExpression(node: BinaryExpression, input = ZrInputStream.empty()) {
		const { left, operator, right } = node;
		if (operator === "|") {
			this.runtimeAssert(
				types.isCallableExpression(left) &&
					(types.isCallableExpression(right) || isNode(right, ZrNodeKind.BinaryExpression)),
				"Pipe expression only works with two command statements",
				ZrRuntimeErrorCode.PipeError,
			);
			const output = new ZrOutputStream();
			const context = ZrContext.createPipedContext(this, input, output);
			const result = this.evaluateFunctionCall(left, context);

			if (result !== undefined && result !== ZrUndefined) {
				output.write(result);
			}

			if (types.isCallableExpression(right)) {
				this.evaluateFunctionCall(
					right,
					ZrContext.createPipedContext(this, output._toInputStream(), this.context.getOutput()),
				);
			} else {
				this.evaluateBinaryExpression(right, output._toInputStream());
			}
		} else if (operator === "&&") {
			if (types.isCallableExpression(left)) {
				const result = this.evaluateFunctionCall(left, this.context);
				if (result === undefined || (result !== undefined && result !== ZrUndefined)) {
					return this.evaluateNode(right);
				}
			} else {
				const result = this.evaluateNode(left);
				if (result !== undefined && result !== ZrUndefined) {
					return this.evaluateNode(right);
				}
			}
		} else if (operator === "||") {
			if (types.isCallableExpression(left)) {
				const result = this.evaluateFunctionCall(left, this.context);
				if (result !== undefined || result === ZrUndefined) {
					return this.evaluateNode(right);
				}
			} else {
				this.runtimeError("Binary OR not handled", ZrRuntimeErrorCode.EvaluationError);
			}
		} else if (operator === "..") {
			const leftValue = this.evaluateNode(left);
			const rightValue = this.evaluateNode(right);
			if (typeIs(leftValue, "number") && typeIs(rightValue, "number")) {
				return new ZrRange(new NumberRange(leftValue, rightValue));
			} else {
				this.runtimeError("Range operator expects two numbers", ZrRuntimeErrorCode.InvalidRangeError, node);
			}
		} else if (operator === "=" && types.isIdentifier(left)) {
			const assignment = this.getLocals().setUpValueOrLocalIfDefined(left.name, this.evaluateNode(right));
			if (assignment.isErr()) {
				const err = assignment.unwrapErr();
				switch (err) {
					case StackValueAssignmentError.ReassignConstant:
						this.runtimeError(
							`Cannot reassign constant '${left.name}'`,
							ZrRuntimeErrorCode.ReassignConstant,
							left,
						);
					case StackValueAssignmentError.VariableNotDeclared:
						this.runtimeError(
							`Unable to assign to undeclared '${left.name}' - use 'let' or 'const'`,
							ZrRuntimeErrorCode.UnassignedVariable,
							left,
						);
				}
			} else {
				return assignment.unwrap();
			}
		} else {
			this.runtimeError(`Unhandled expression '${operator}'`, ZrRuntimeErrorCode.EvaluationError);
		}
		return undefined;
	}

	/** @internal */
	public evaluateNode(node: Node): ZrValue | ZrUndefined | undefined {
		if (isNode(node, ZrNodeKind.Source)) {
			for (const subNode of node.children) {
				this.evaluateNode(subNode);
			}
			return undefined;
		} else if (isNode(node, ZrNodeKind.String)) {
			return node.text;
		} else if (isNode(node, ZrNodeKind.Identifier)) {
			return this.getLocals().getLocalOrUpValue(node.name)?.[0] ?? ZrUndefined;
		} else if (isNode(node, ZrNodeKind.ArrayIndexExpression)) {
			return this.evaluateArrayIndexExpression(node);
		} else if (isNode(node, ZrNodeKind.PropertyAccessExpression)) {
			return this.evaluatePropertyAccessExpression(node) ?? ZrUndefined;
		} else if (isNode(node, ZrNodeKind.FunctionDeclaration)) {
			return this.evaluateFunctionDeclaration(node);
		} else if (isNode(node, ZrNodeKind.EnumDeclaration)) {
			return this.evaluateEnumDeclaration(node);
		} else if (isNode(node, ZrNodeKind.ParenthesizedExpression)) {
			return this.evaluateNode(node.expression);
		} else if (isNode(node, ZrNodeKind.BinaryExpression)) {
			return this.evaluateBinaryExpression(node);
		} else if (isNode(node, ZrNodeKind.UnaryExpression)) {
			if (node.operator === "!") {
				const result = this.evaluateNode(node.expression);
				return result === false || result === undefined || result === ZrUndefined;
			}
		} else if (isNode(node, ZrNodeKind.UndefinedKeyword)) {
			return ZrUndefined;
		} else if (isNode(node, ZrNodeKind.ExpressionStatement)) {
			const value = this.evaluateNode(node.expression);
			if (value !== undefined) {
				this.context.getOutput().write(value);
			}
		} else if (isNode(node, ZrNodeKind.ForInStatement)) {
			this.evaluateForInStatement(node);
		} else if (isNode(node, ZrNodeKind.IfStatement)) {
			this.evaluateIfStatement(node);
		} else if (isNode(node, ZrNodeKind.ObjectLiteralExpression)) {
			return this.evaluateObjectNode(node);
		} else if (isNode(node, ZrNodeKind.ArrayLiteralExpression)) {
			return this.evaluateArrayNode(node);
		} else if (isNode(node, ZrNodeKind.Number) || isNode(node, ZrNodeKind.Boolean)) {
			return node.value;
		} else if (isNode(node, ZrNodeKind.InterpolatedString)) {
			return this.getLocals().evaluateInterpolatedString(node);
		} else if (isNode(node, ZrNodeKind.VariableStatement)) {
			return this.executeSetVariable(node.declaration);
		} else if (isNode(node, ZrNodeKind.FunctionExpression)) {
			return this.evaluateFunctionExpression(node);
		} else if (isNode(node, ZrNodeKind.Block)) {
			this.push();
			for (const statement of node.statements) {
				this.evaluateNode(statement);
			}
			this.pop();
		} else if (types.isCallableExpression(node)) {
			return this.evaluateFunctionCall(node, this.context);
		} else {
			this.runtimeError(`Failed to evaluate ${getFriendlyName(node)}`, ZrRuntimeErrorCode.EvaluationError, node);
		}
	}

	public getExecutingPlayer() {
		return this.executingPlayer;
	}

	public execute() {
		this.evaluateNode(this.source);
		return this.context.getOutput();
	}
}

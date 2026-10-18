/**
 * `check-runtime` 专用的极简 semver 实现。
 *
 * 为什么不直接 `import semver`:**目标是 DSH 运行时的 node_modules**,里面
 * 未必有 semver(它不是 DSH 的直接依赖,是否被提升到顶层取决于包管理器);
 * 这个检查器的价值在于「只依赖目标运行时本身」,不能为了版本判断再引入
 * 一个可能缺失的依赖。
 *
 * 支持插件 `peerDependencies` 会用到的那一小撮语法:
 *   - `^x.y.z[-pre]`、`~x.y.z[-pre]`、`>=`、`>`、`<=`、`<`、`=`、裸版本;
 *   - 空格分隔表示 AND,`||` 表示 OR。
 *
 * 预发布规则与 npm 一致:带 prerelease 的版本,只有当同一
 * `[major, minor, patch]` 上也有带 prerelease 的比较器时,才可能命中。
 * 这正是「`^0.2.0-rc.1` 匹配不了 `0.2.1-rc.2`」的成因。
 */

/** 解析版本号;不合法返回 null。 */
export function parseVersion(text) {
	if (typeof text !== "string") return null;
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
	if (match === null) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] === undefined ? [] : match[4].split(".")
	};
}

/** 比较两个 prerelease 标识符。 */
function compareIdentifier(left, right) {
	const leftNumber = /^\d+$/.test(left);
	const rightNumber = /^\d+$/.test(right);
	if (leftNumber && rightNumber) return Number(left) - Number(right);
	if (leftNumber) return -1;
	if (rightNumber) return 1;
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 按 semver 规则比较两个已解析版本。
 * @returns 负数/0/正数。
 */
export function compareVersions(left, right) {
	for (const key of ["major", "minor", "patch"]) {
		if (left[key] !== right[key]) return left[key] - right[key];
	}
	if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
	if (left.prerelease.length === 0) return 1;
	if (right.prerelease.length === 0) return -1;
	const length = Math.max(left.prerelease.length, right.prerelease.length);
	for (let index = 0; index < length; index += 1) {
		const a = left.prerelease[index];
		const b = right.prerelease[index];
		if (a === undefined) return -1;
		if (b === undefined) return 1;
		const diff = compareIdentifier(a, b);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** 解析单个比较器(运算符 + 版本);不合法返回 null。 */
function parseComparator(token) {
	const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token.trim());
	if (match === null) return null;
	const version = parseVersion(match[2]);
	if (version === null) return null;
	return { operator: match[1] ?? "=", version };
}

/** `^` 的上界。 */
function caretUpper(version) {
	if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, prerelease: [] };
	if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] };
	return { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
}

/** `~` 的上界。 */
function tildeUpper(version) {
	return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] };
}

/** 单个比较器是否命中。 */
function matchesComparator(comparator, version) {
	const diff = compareVersions(version, comparator.version);
	switch (comparator.operator) {
		case "^":
			return diff >= 0 && compareVersions(version, caretUpper(comparator.version)) < 0;
		case "~":
			return diff >= 0 && compareVersions(version, tildeUpper(comparator.version)) < 0;
		case ">=":
			return diff >= 0;
		case ">":
			return diff > 0;
		case "<=":
			return diff <= 0;
		case "<":
			return diff < 0;
		default:
			return diff === 0;
	}
}

/** 一组 AND 比较器是否命中。 */
function matchesComparatorSet(version, tokens) {
	const comparators = tokens.map(parseComparator);
	if (comparators.some((comparator) => comparator === null)) return false;
	// npm 的预发布规则:prerelease 版本只有在同一 [major,minor,patch] 的
	// 比较器也带 prerelease 时才可能命中。
	if (version.prerelease.length > 0) {
		const sameTuple = comparators.some((comparator) =>
			comparator.version.prerelease.length > 0 &&
			comparator.version.major === version.major &&
			comparator.version.minor === version.minor &&
			comparator.version.patch === version.patch);
		if (!sameTuple) return false;
	}
	return comparators.every((comparator) => matchesComparator(comparator, version));
}

/**
 * 版本是否满足范围。
 * @param versionText - 版本号,如 `0.2.1-rc.2`。
 * @param rangeText - 范围,如 `^0.1.7-rc.1 || ^0.2.0-rc.1`。
 * @returns 是否满足;任一侧无法解析时返回 false。
 */
export function satisfiesRange(versionText, rangeText) {
	const version = parseVersion(versionText);
	if (version === null) return false;
	if (typeof rangeText !== "string") return false;
	const alternatives = rangeText.split("||").map((part) => part.trim()).filter((part) => part.length > 0);
	if (alternatives.length === 0) return false;
	return alternatives.some((alternative) => matchesComparatorSet(version, alternative.split(/\s+/).filter(Boolean)));
}

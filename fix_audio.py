import re

with open('src/GuildManager.js', 'r') as f:
    content = f.read()

search_pattern = r"const ff = spawn\('ffmpeg'.*?const resource = createAudioResource\(opus, { inputType: StreamType\.Opus }\);"
replace_pattern = r"const resource = createAudioResource(filePath);"

new_content = re.sub(search_pattern, replace_pattern, content, flags=re.DOTALL)

with open('src/GuildManager.js', 'w') as f:
    f.write(new_content)

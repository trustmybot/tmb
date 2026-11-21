# Prints how many to-do items are open. Ruby: a language tmb does not read.
require "json"

def open_count(path)
  JSON.parse(File.read(path)).count { |item| !item["done"] }
end

puts "#{open_count(ARGV.fetch(0, "todo.json"))} open"
